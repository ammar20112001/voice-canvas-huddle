import { createShapeId, toRichText } from 'tldraw'
import { layoutSchema } from './diagramLayout'

const NODE_STAGGER_MS = 150
const EDGE_STAGGER_MS = 100

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`
}

// Tracks what's already been drawn for one canvas across repeated
// renderSchema() calls, so a later "extend" schema only adds what's new
// instead of redrawing everything. Create one per canvas/session.
//
// schemaIds is the reverse of shapeIds (tldraw shape id -> schema node id) -
// diagramSync.js needs it to report manual edits back using the same node
// ids Jarvis already knows, instead of tldraw's internal shape ids.
export function createRenderState() {
  return { shapeIds: {}, schemaIds: {}, drawnEdgeKeys: new Set() }
}

// Renders a {action, diagram_type, nodes, edges} schema onto the tldraw
// canvas. `schema` is always the FULL diagram as understood so far (the
// backend merges extend/new itself) - this function diffs against `state`
// to figure out what's actually new, and only creates those shapes, one at
// a time, so the diagram visibly draws itself instead of popping in all at
// once. On action "new" the canvas (and state) is cleared first.
//
// Every mutation here runs inside editor.store.mergeRemoteChanges() so it's
// tagged source: 'remote' - diagramSync.js listens for source: 'user' only,
// so Jarvis's own draws never get mistaken for (and echoed back as) a
// manual edit.
export async function renderSchema(editor, schema, state) {
  if (!schema) return

  if (schema.action === 'new') {
    const existingIds = Array.from(editor.getCurrentPageShapeIds())
    if (existingIds.length) {
      editor.store.mergeRemoteChanges(() => {
        editor.deleteShapes(existingIds)
      })
    }
    state.shapeIds = {}
    state.schemaIds = {}
    state.drawnEdgeKeys = new Set()
  }

  if (schema.diagram_type === 'none' || !schema.nodes?.length) {
    return
  }

  // Laying out the full graph on every call (not just the new nodes) keeps
  // new nodes positioned sensibly relative to old ones, at the cost of
  // recomputing positions for nodes that are already drawn - those aren't
  // moved, so as the diagram grows a later layout pass can drift from
  // where earlier nodes actually ended up. Fine for a prototype; a stable
  // incremental layout is future work.
  const boxes = layoutSchema(schema)

  for (const node of schema.nodes) {
    if (state.shapeIds[node.id]) continue // already drawn

    const id = createShapeId()
    state.shapeIds[node.id] = id
    state.schemaIds[id] = node.id
    const box = boxes[node.id]

    editor.store.mergeRemoteChanges(() => {
      editor.createShape({
        id,
        type: 'geo',
        x: box.x,
        y: box.y,
        props: {
          geo: 'rectangle',
          w: box.w,
          h: box.h,
          richText: toRichText(node.label ?? ''),
        },
      })
    })
    await sleep(NODE_STAGGER_MS)
  }

  for (const edge of schema.edges) {
    const key = edgeKey(edge)
    if (state.drawnEdgeKeys.has(key)) continue

    const fromShapeId = state.shapeIds[edge.from]
    const toShapeId = state.shapeIds[edge.to]
    if (!fromShapeId || !toShapeId) continue
    state.drawnEdgeKeys.add(key)

    const arrowId = createShapeId()
    const fromBox = boxes[edge.from]
    const toBox = boxes[edge.to]

    editor.store.mergeRemoteChanges(() => {
      editor.createShape({
        id: arrowId,
        type: 'arrow',
        x: 0,
        y: 0,
        props: {
          // Initial points in case binding resolution ever fails - normally
          // overridden visually once the bindings below attach.
          start: { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 },
          end: { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 },
          richText: toRichText(edge.label ?? ''),
        },
      })

      // Binding by shape id (not raw coordinates) means the arrow follows
      // the box automatically if it's later dragged.
      editor.createBindings([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: fromShapeId,
          props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: toShapeId,
          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
        },
      ])
    })

    await sleep(EDGE_STAGGER_MS)
  }

  editor.zoomToFit({ animation: { duration: 300 } })
}
