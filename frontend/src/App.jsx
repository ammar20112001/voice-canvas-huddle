import { useCallback, useRef, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import './App.css'
import { startAudioCapture } from './lib/audioCapture'
import { createRenderState, renderSchema } from './lib/diagramRender'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/audio'

export default function App() {
  const editorRef = useRef(null)
  const wsRef = useRef(null)
  const stopCaptureRef = useRef(null)
  const renderStateRef = useRef(createRenderState())
  const [status, setStatus] = useState('idle') // idle | connecting | listening | error

  const handleMount = useCallback((editor) => {
    editorRef.current = editor
  }, [])

  const stop = useCallback(() => {
    stopCaptureRef.current?.()
    stopCaptureRef.current = null
    wsRef.current?.close()
    wsRef.current = null
    setStatus('idle')
  }, [])

  const start = useCallback(async () => {
    setStatus('connecting')
    // Each session gets its own backend-tracked diagram state (see
    // backend/server.py), so the frontend's picture of "what's already
    // drawn" needs to reset alongside it.
    renderStateRef.current = createRenderState()
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = async () => {
      try {
        stopCaptureRef.current = await startAudioCapture(ws)
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
      stopCaptureRef.current?.()
      stopCaptureRef.current = null
      setStatus('idle')
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
        <span className={`status status-${status}`}>{status}</span>
      </div>
      <div className="canvas">
        <Tldraw onMount={handleMount} />
      </div>
    </div>
  )
}
