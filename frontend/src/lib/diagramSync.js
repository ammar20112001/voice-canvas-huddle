import { getArrowBindings, renderPlaintextFromRichText } from 'tldraw'
import { getDiagramState } from './diagramRender'

// Watches the canvas for manual edits (drag, rename, delete, a shape drawn
// by hand) and streams the resulting diagram set back to the backend over
// the same WebSocket used for audio, as a JSON text message - so Jarvis's
// next LLM call reflects what's actually on screen instead of drifting
// from it.
//
// Only fires for source: 'user' changes. diagramRender.js wraps every
// AI-driven mutation in editor.store.mergeRemoteChanges(), which tags them
// source: 'remote', so Jarvis's own draws never get picked up here and
// echoed straight back as if they were a manual edit.
const SYNC_DEBOUNCE_MS = 600
const MANUAL_DIAGRAM_ID = 'manual'

function nearestDiagramId(shape, state) {
  const entries = Object.entries(state.regionOffsets)
  if (!entries.length) return null
  let bestId = null
  let bestDist = Infinity
  for (const [diagramId, offsetX] of entries) {
    const regionWidth = state.diagrams[diagramId]?.width || 0
    const regionCenter = offsetX + regionWidth / 2
    const dist = Math.abs(shape.x - regionCenter)
    if (dist < bestDist) {
      bestDist = dist
      bestId = diagramId
    }
  }
  return bestId
}

// A shape the user drew by hand has no diagram association yet - group it
// with whichever existing diagram's region it's closest to (probably drawn
// near/inside that cluster), or a shared catch-all "Manual edits" diagram
// if the canvas has none yet.
function diagramIdForShape(shape, state) {
  const known = state.shapeToDiagram[shape.id]
  if (known) return known
  const diagramId = nearestDiagramId(shape, state) ?? MANUAL_DIAGRAM_ID
  state.shapeToDiagram[shape.id] = diagramId
  return diagramId
}

function serializeDiagrams(editor, state) {
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
    const diagramId = diagramIdForShape(shape, state)
    const dState = getDiagramState(state, diagramId)

    let nodeId = dState.schemaIds[shape.id]
    if (!nodeId) {
      nodeId = `user_${shape.id.replace('shape:', '')}`
      dState.schemaIds[shape.id] = nodeId
      dState.shapeIds[nodeId] = shape.id
    }
    bucketFor(diagramId).nodes.push({ id: nodeId, label: renderPlaintextFromRichText(editor, shape.props.richText) })
  }

  for (const shape of shapes) {
    if (shape.type !== 'arrow') continue
    const bindings = getArrowBindings(editor, shape)
    if (!bindings.start || !bindings.end) continue // unbound arrow - no clear from/to, skip

    // Both bound shapes were already visited in the geo loop above (Jarvis
    // never draws cross-diagram edges, so they're expected to agree on
    // which diagram) - attribute the edge to the start shape's diagram.
    const diagramId = state.shapeToDiagram[bindings.start.toId] ?? MANUAL_DIAGRAM_ID
    const dState = getDiagramState(state, diagramId)
    const fromId = dState.schemaIds[bindings.start.toId]
    const toId = dState.schemaIds[bindings.end.toId]
    if (!fromId || !toId) continue

    const label = renderPlaintextFromRichText(editor, shape.props.richText)
    bucketFor(diagramId).edges.push(label ? { from: fromId, to: toId, label } : { from: fromId, to: toId })
  }

  return Object.values(buckets)
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
        ws.send(JSON.stringify({ type: 'diagram_edit', diagrams: serializeDiagrams(editor, state) }))
      }, SYNC_DEBOUNCE_MS)
    },
    { source: 'user', scope: 'document' }
  )

  return function stopWatchingForManualEdits() {
    clearTimeout(debounceTimer)
    unsubscribe()
  }
}
