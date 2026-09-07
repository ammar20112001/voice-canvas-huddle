import { getArrowBindings, renderPlaintextFromRichText } from 'tldraw'

// Watches the canvas for manual edits (drag, rename, delete, a shape drawn
// by hand) and streams the resulting diagram back to the backend over the
// same WebSocket used for audio, as a JSON text message - so Jarvis's next
// LLM call reflects what's actually on screen instead of drifting from it.
//
// Only fires for source: 'user' changes. diagramRender.js wraps every
// AI-driven mutation in editor.store.mergeRemoteChanges(), which tags them
// source: 'remote', so Jarvis's own draws never get picked up here and
// echoed straight back as if they were a manual edit.
const SYNC_DEBOUNCE_MS = 600

function serializeDiagram(editor, state) {
  const shapes = editor.getCurrentPageShapes()
  const nodes = []
  const edges = []

  for (const shape of shapes) {
    if (shape.type !== 'geo') continue
    let nodeId = state.schemaIds[shape.id]
    if (!nodeId) {
      // A shape the user created by hand - Jarvis has never seen it, so
      // mint an id and register it both ways for stable future edits.
      nodeId = `user_${shape.id.replace('shape:', '')}`
      state.schemaIds[shape.id] = nodeId
      state.shapeIds[nodeId] = shape.id
    }
    nodes.push({ id: nodeId, label: renderPlaintextFromRichText(editor, shape.props.richText) })
  }

  for (const shape of shapes) {
    if (shape.type !== 'arrow') continue
    const bindings = getArrowBindings(editor, shape)
    const fromId = bindings.start && state.schemaIds[bindings.start.toId]
    const toId = bindings.end && state.schemaIds[bindings.end.toId]
    if (!fromId || !toId) continue // unbound arrow - no clear from/to, skip

    const label = renderPlaintextFromRichText(editor, shape.props.richText)
    edges.push(label ? { from: fromId, to: toId, label } : { from: fromId, to: toId })
  }

  return { nodes, edges }
}

// Returns a cleanup function - call it when the WebSocket this was set up
// for closes (a new one needs its own watcher).
export function watchForManualEdits(editor, ws, state) {
  let debounceTimer = null

  const unsubscribe = editor.store.listen(
    () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify(serializeDiagram(editor, state)))
      }, SYNC_DEBOUNCE_MS)
    },
    { source: 'user', scope: 'document' }
  )

  return function stopWatchingForManualEdits() {
    clearTimeout(debounceTimer)
    unsubscribe()
  }
}
