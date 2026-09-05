# Voice to Diagram - frontend

React + [tldraw](https://tldraw.dev) client. Captures mic audio via an
AudioWorklet, streams raw PCM16 frames to the backend over a WebSocket, and
progressively renders the returned `{diagram_type, nodes, edges}` schema onto
an infinite canvas (layout via [dagre](https://github.com/dagrejs/dagre)).

## Setup

```
npm install
cp .env.example .env   # only needed if the backend isn't on localhost:8000
npm run dev
```

Requires `backend/server.py` running (see the repo root README) - the
"Start listening" button opens a WebSocket to `VITE_WS_URL`
(`ws://localhost:8000/ws/audio` by default).

## Layout

- `src/App.jsx` - mounts the tldraw canvas, owns the WebSocket connection and start/stop state
- `src/lib/audioCapture.js` - mic capture + AudioWorklet wiring, sends binary PCM16 over the socket
- `src/worklets/pcm-worklet.js` - AudioWorkletProcessor that chunks samples into 30ms/480-sample frames
- `src/lib/diagramLayout.js` - dagre layout, schema nodes/edges -> `{x, y, w, h}` boxes
- `src/lib/diagramRender.js` - turns a schema + layout into staggered `editor.createShape` calls
