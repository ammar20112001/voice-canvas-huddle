// All backend URLs are same-origin paths (see vite.config.js for the dev
// proxy; production uses the reverse proxy with the same routes).
const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

export const roomApiUrl = (roomId) => `/api/rooms/${encodeURIComponent(roomId)}`
export const createRoomUrl = '/api/rooms'
export const jarvisSocketUrl = (roomId, name) =>
  `${wsBase}/api/ws/rooms/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name)}`
export const syncUrl = (roomId) => `${wsBase}/sync/${encodeURIComponent(roomId)}`
