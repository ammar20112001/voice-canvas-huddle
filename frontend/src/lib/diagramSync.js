import { getArrowBindings, renderPlaintextFromRichText } from 'tldraw'
import { getDiagramState, isRendering, rebuildRenderState } from './diagramRender'

// Watches the shared board for manual edits (drag, rename, delete, a shape
// drawn by hand - by ANY participant) and reports the resulting diagram set
// to the backend over the room WebSocket, so Jarvis's next LLM call
// reflects what's actually on screen instead of drifting from it.
//
// Every client reports its own local edits. The diagram/node mapping comes
// from the document itself (rebuildRenderState reads shape.meta), not from
// in-memory state, so it works for whoever happens to be editing.
//
// Only source:'user' changes fire this - edits arriving from other
// participants over tldraw sync are 'remote' and are reported by whoever
// made them. The scribe's own Jarvis draws DO look like user edits locally;
// those are held back while a render is in flight (isRendering) and the
// backend drops the resulting report as a no-op since it already holds
// that exact diagram set.
const SYNC_DEBOUNCE_MS = 600
const MANUAL_DIAGRAM_ID = 'manual'

function serializeDiagrams(editor) {
  const state = rebuildRenderState(editor)
  const shapes = editor.getCurrentPageShapes()
  const buckets = {} // diagramId -> {id, title, diagram_type, nodes, edges}

  function bucketFor(diagramId) {
    if (!buckets[diagramId]) {
      const dState = getDiagramState(state, diagramId)
      buckets[diagramId] = {
        id: diagramId,
        title: dState.title ?? 'Manual edits',
        diagram_type: dState.diagramType ?? 'flow',
        nodes: [],
        edges: [],
      }
    }
    return buckets[diagramId]
  }

  for (const shape of shapes) {
    if (shape.type !== 'geo') continue
    const diagramId = state.shapeToDiagram[shape.id] ?? MANUAL_DIAGRAM_ID
    const dState = getDiagramState(state, diagramId)
    const nodeId = dState.schemaIds[shape.id]
    if (!nodeId) continue
    bucketFor(diagramId).nodes.push({ id: nodeId, label: renderPlaintextFromRichText(editor, shape.props.richText) })
  }

  for (const shape of shapes) {
    if (shape.type !== 'arrow') continue
    const bindings = getArrowBindings(editor, shape)
    if (!bindings.end) continue // no bound target - no clear "to", skip

    // Both bound shapes were already visited in the geo loop above (Jarvis
    // never draws cross-diagram edges, so they're expected to agree on
    // which diagram) - attribute the edge to the target shape's diagram.
    const diagramId = state.shapeToDiagram[bindings.end.toId] ?? MANUAL_DIAGRAM_ID
    const dState = getDiagramState(state, diagramId)
    const toId = dState.schemaIds[bindings.end.toId]
    if (!toId) continue

    // A normal edge the user hand-drew with tldraw's own arrow tool has
    // both ends bound - read "from" the same way as "to". An AI-routed
    // edge's final-hop arrow (see diagramRender.js's drawRoutedEdge) is
    // deliberately bound at its end only, so its start binding won't
    // exist - its true source is recorded separately at draw time.
    const fromId = bindings.start ? dState.schemaIds[bindings.start.toId] : dState.edgeSourceNode[shape.id]
    if (!fromId) continue

    const label = renderPlaintextFromRichText(editor, shape.props.richText)
    bucketFor(diagramId).edges.push(label ? { from: fromId, to: toId, label } : { from: fromId, to: toId })
  }

  return Object.values(buckets)
}

// Returns a cleanup function - call it when the WebSocket this was set up
// for closes (a new one needs its own watcher).
export function watchForManualEdits(editor, ws) {
  let debounceTimer = null

  function arm() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, SYNC_DEBOUNCE_MS)
  }

  function flush() {
    if (ws.readyState !== WebSocket.OPEN) return
    if (isRendering()) return arm() // mid-draw: the board is only partly drawn
    ws.send(JSON.stringify({ type: 'diagram_edit', diagrams: serializeDiagrams(editor) }))
  }

  const unsubscribe = editor.store.listen(arm, { source: 'user', scope: 'document' })

  return function stopWatchingForManualEdits() {
    clearTimeout(debounceTimer)
    unsubscribe()
  }
}
