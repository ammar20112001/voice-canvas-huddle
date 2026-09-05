import { createShapeId, toRichText } from 'tldraw'
import { layoutSchema } from './diagramLayout'

const NODE_STAGGER_MS = 150
const EDGE_STAGGER_MS = 100

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Renders a {diagram_type, nodes, edges} schema onto the tldraw canvas,
// creating one shape at a time so the diagram visibly draws itself instead
// of popping in all at once - masks the latency of schema generation.
export async function renderSchema(editor, schema) {
  if (!schema || schema.diagram_type === 'none' || !schema.nodes?.length) {
    return
  }

  const boxes = layoutSchema(schema)
  const shapeIds = {}

  for (const node of schema.nodes) {
    const id = createShapeId()
    shapeIds[node.id] = id
    const box = boxes[node.id]

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
    await sleep(NODE_STAGGER_MS)
  }

  for (const edge of schema.edges) {
    const fromShapeId = shapeIds[edge.from]
    const toShapeId = shapeIds[edge.to]
    if (!fromShapeId || !toShapeId) continue

    const arrowId = createShapeId()
    const fromBox = boxes[edge.from]
    const toBox = boxes[edge.to]

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

    // Binding by shape id (not raw coordinates) means the arrow follows the
    // box automatically if it's later dragged.
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

    await sleep(EDGE_STAGGER_MS)
  }

  editor.zoomToFit({ animation: { duration: 300 } })
}
