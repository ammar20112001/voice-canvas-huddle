import { useCallback, useRef, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import './App.css'
import { startAudioCapture } from './lib/audioCapture'
import { createRenderState, renderSchema } from './lib/diagramRender'
import { watchForManualEdits } from './lib/diagramSync'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/audio'

export default function App() {
  const editorRef = useRef(null)
  const wsRef = useRef(null)
  const stopCaptureRef = useRef(null)
  const stopSyncRef = useRef(null)
  // Persists across reconnects rather than resetting in start() - the
  // backend now keeps its diagrams across a drop too (see backend/server.py's
  // _SessionState) and pushes them back immediately on reconnect, at which
  // point renderSchema's "replace_all" handling resets this anyway. Not
  // resetting here means the id mapping stays valid if a reconnect happens
  // without a full page reload (the canvas never actually went away).
  const renderStateRef = useRef(createRenderState())
  const [status, setStatus] = useState('idle') // idle | connecting | listening | error

  const handleMount = useCallback((editor) => {
    editorRef.current = editor
  }, [])

  const stop = useCallback(() => {
    stopSyncRef.current?.()
    stopSyncRef.current = null
    stopCaptureRef.current?.()
    stopCaptureRef.current = null
    wsRef.current?.close()
    wsRef.current = null
    setStatus('idle')
  }, [])

  const start = useCallback(async () => {
    setStatus('connecting')
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = async () => {
      try {
        stopCaptureRef.current = await startAudioCapture(ws)
        if (editorRef.current) {
          stopSyncRef.current = watchForManualEdits(editorRef.current, ws, renderStateRef.current)
        }
        setStatus('listening')
      } catch (err) {
        console.error('[app] mic capture failed', err)
        setStatus('error')
        ws.close()
      }
    }

    ws.onmessage = (event) => {
      const schema = JSON.parse(event.data)
      if (editorRef.current) {
        renderSchema(editorRef.current, schema, renderStateRef.current)
      }
    }

    ws.onerror = (err) => {
      console.error('[app] websocket error', err)
      setStatus('error')
    }

    ws.onclose = () => {
      stopSyncRef.current?.()
      stopSyncRef.current = null
      stopCaptureRef.current?.()
      stopCaptureRef.current = null
      setStatus('idle')
    }
  }, [])

  const undo = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'undo' }))
    }
  }, [])

  return (
    <div className="app">
      <div className="controls">
        <button
          onClick={status === 'listening' ? stop : start}
          disabled={status === 'connecting'}
        >
          {status === 'listening'
            ? 'Stop listening'
            : status === 'connecting'
              ? 'Connecting...'
              : 'Start listening'}
        </button>
        <button onClick={undo} disabled={status !== 'listening'} title="Revert the last change (voice or manual)">
          Undo
        </button>
        <span className={`status status-${status}`}>{status}</span>
      </div>
      <div className="canvas">
        <Tldraw onMount={handleMount} />
      </div>
    </div>
  )
}
