// Whiteboard sync service: tldraw multiplayer, one TLSocketRoom per call.
//
// Browsers connect to ws://<host>/sync/<roomId> (see frontend's useSync).
// The Python backend owns room identity - a connection is only accepted if
// GET <BACKEND_URL>/api/rooms/<roomId> says the room exists, so strangers
// can't conjure boards by guessing paths. The document lives in memory
// while anyone is connected and is snapshotted to disk, so it survives
// everyone leaving and a restart of this service.

import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TLSocketRoom } from '@tldraw/sync-core'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.SYNC_PORT || 5858)
const HOST = process.env.SYNC_HOST || '127.0.0.1'
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000'
const DATA_DIR =
  process.env.SYNC_DATA_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sync')
const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const PERSIST_DEBOUNCE_MS = 2000

const rooms = new Map() // roomId -> { room, persistTimer }

const snapshotPath = (roomId) => path.join(DATA_DIR, `${roomId}.json`)

async function loadSnapshot(roomId) {
  try {
    return JSON.parse(await readFile(snapshotPath(roomId), 'utf8'))
  } catch {
    return undefined
  }
}

async function persist(roomId, room) {
  try {
    await mkdir(DATA_DIR, { recursive: true })
    const tmp = `${snapshotPath(roomId)}.tmp`
    await writeFile(tmp, JSON.stringify(room.getCurrentSnapshot()))
    await rename(tmp, snapshotPath(roomId))
  } catch (err) {
    console.error(`[sync] failed to persist ${roomId}`, err)
  }
}

async function roomExists(roomId) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/rooms/${encodeURIComponent(roomId)}`)
    return res.ok
  } catch (err) {
    console.error('[sync] backend unreachable while checking room', err.message)
    return false
  }
}

// Concurrent first-connections for the same room must share one creation.
const pending = new Map()

function getRoom(roomId) {
  const existing = rooms.get(roomId)
  if (existing && !existing.room.isClosed()) return Promise.resolve(existing.room)
  if (pending.has(roomId)) return pending.get(roomId)

  const creating = (async () => {
    const initialSnapshot = await loadSnapshot(roomId)
    const entry = { room: null, persistTimer: null }
    entry.room = new TLSocketRoom({
      initialSnapshot,
      onSessionRemoved(room, { numSessionsRemaining }) {
        if (numSessionsRemaining > 0) return
        clearTimeout(entry.persistTimer)
        persist(roomId, room).then(() => {
          room.close()
          rooms.delete(roomId)
          console.log(`[sync] room ${roomId} emptied, saved and unloaded`)
        })
      },
      onDataChange() {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = setTimeout(() => persist(roomId, entry.room), PERSIST_DEBOUNCE_MS)
      },
    })
    rooms.set(roomId, entry)
    return entry.room
  })().finally(() => pending.delete(roomId))

  pending.set(roomId, creating)
  return creating
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok')
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', async (req, socket, head) => {
  const reject = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  const url = new URL(req.url, 'http://localhost')
  const match = url.pathname.match(/^\/sync\/([^/]+)$/)
  const sessionId = url.searchParams.get('sessionId')
  if (!match || !sessionId || !ROOM_ID_RE.test(match[1])) return reject(400, 'Bad Request')
  const roomId = match[1]

  if (!rooms.has(roomId) && !(await roomExists(roomId))) return reject(404, 'Not Found')

  try {
    const room = await getRoom(roomId)
    wss.handleUpgrade(req, socket, head, (ws) => {
      room.handleSocketConnect({ sessionId, socket: ws })
    })
  } catch (err) {
    console.error(`[sync] failed to connect to room ${roomId}`, err)
    reject(500, 'Internal Server Error')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[sync] listening on ${HOST}:${PORT}, backend ${BACKEND_URL}, data ${DATA_DIR}`)
})

async function shutdown() {
  await Promise.all([...rooms].map(([id, { room }]) => persist(id, room)))
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
