// All backend URLs are same-origin paths (see vite.config.js for the dev
// proxy; production uses the reverse proxy with the same routes).
const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

export const roomApiUrl = (roomId) => `/api/rooms/${encodeURIComponent(roomId)}`
export const createRoomUrl = '/api/rooms'
// `peer` doubles as this participant's LiveKit identity, so the roster and
// "who is speaking" refer to the same id.
export const jarvisSocketUrl = (roomId, name, peer) =>
  `${wsBase}/api/ws/rooms/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name)}&peer=${encodeURIComponent(peer)}`
export const callTokenUrl = (roomId) => `/api/rooms/${encodeURIComponent(roomId)}/call-token`
// LiveKit signalling, proxied same-origin like everything else (the media
// itself goes straight to the LiveKit server over UDP/TCP, not through here).
export const livekitUrl = `${wsBase}/livekit`
export const syncUrl = (roomId) => `${wsBase}/sync/${encodeURIComponent(roomId)}`
