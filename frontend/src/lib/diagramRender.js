import { createShapeId, renderPlaintextFromRichText, toRichText } from 'tldraw'
import { layoutDiagram } from './diagramLayout'

const NODE_STAGGER_MS = 150
const EDGE_STAGGER_MS = 100
const DIAGRAM_GUTTER = 200 // horizontal gap between separate diagrams' regions
const TITLE_HEIGHT = 40
const REFERENCE_LABEL = 'zooms into / relates to'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`
}

// Tracks what's already been drawn across repeated renderSchema() calls, so
// a later message only adds what's new instead of redrawing everything.
// Per-diagram state lives under `diagrams[diagramId]` since node ids are
// only unique within their own diagram (two different diagrams can both
// have a node called "start"). `shapeToDiagram` is the one thing that
// isn't per-diagram - diagramSync.js needs a flat shape -> diagram lookup
// to know which diagram a shape it's serializing belongs to. Create one per
// canvas/session.
export function createRenderState() {
  return { diagrams: {}, regionOffsets: {}, order: [], shapeToDiagram: {} }
}

// Exported so diagramSync.js can read/create the same per-diagram bucket
// when reporting a manual edit back - one shape, not two drifting copies.
export function getDiagramState(state, diagramId) {
  if (!state.diagrams[diagramId]) {
    state.diagrams[diagramId] = {
      shapeIds: {},
      schemaIds: {},
      drawnEdgeKeys: new Set(),
      titleShapeId: null,
      width: 0,
      title: null,
      diagramType: null,
      referencesDrawn: false,
    }
  }
  return state.diagrams[diagramId]
}

// Assigns each diagram a horizontal region on the shared canvas so separate
// diagrams never overlap. A region's offset is fixed the first time a
// diagram is drawn and never moves afterward - if a diagram later grows
// wider than the gutter reserved for it, it can visually overlap its
// neighbor. Acceptable for a prototype; a stable re-flowing layout is
// future work.
function assignRegion(state, diagramId, width) {
  const dState = getDiagramState(state, diagramId)
  if (state.regionOffsets[diagramId] === undefined) {
    const usedRight = state.order.reduce((max, id) => {
      const w = state.diagrams[id]?.width || 0
      return Math.max(max, state.regionOffsets[id] + w)
    }, 0)
    state.regionOffsets[diagramId] = state.order.length ? usedRight + DIAGRAM_GUTTER : 0
    state.order.push(diagramId)
  }
  dState.width = Math.max(dState.width, width)
  return state.regionOffsets[diagramId]
}

function clearCanvas(editor, state) {
  const existingIds = Array.from(editor.getCurrentPageShapeIds())
  if (existingIds.length) {
    editor.store.mergeRemoteChanges(() => {
      editor.deleteShapes(existingIds)
    })
  }
  state.diagrams = {}
  state.regionOffsets = {}
  state.order = []
  state.shapeToDiagram = {}
}

// Draws one diagram's not-yet-drawn nodes/edges into its assigned region,
// one shape at a time so it visibly draws itself instead of popping in all
// at once. Every mutation runs inside editor.store.mergeRemoteChanges() so
// it's tagged source: 'remote' - diagramSync.js listens for source: 'user'
// only, so Jarvis's own draws never get mistaken for (and echoed back as) a
// manual edit.
async function drawDiagram(editor, diagram, state) {
  if (!diagram.nodes?.length) return

  const dState = getDiagramState(state, diagram.id)
  dState.title = diagram.title ?? dState.title
  dState.diagramType = diagram.diagram_type ?? dState.diagramType
  const { boxes, width } = layoutDiagram(diagram)
  const offsetX = assignRegion(state, diagram.id, width)

  if (dState.titleShapeId === null && diagram.title) {
    const titleId = createShapeId()
    dState.titleShapeId = titleId
    editor.store.mergeRemoteChanges(() => {
      editor.createShape({
        id: titleId,
        type: 'text',
        x: offsetX,
        y: -TITLE_HEIGHT,
        props: { richText: toRichText(diagram.title), w: Math.max(width, 160), autoSize: false },
      })
    })
  } else if (dState.titleShapeId !== null) {
    // Keep the title's width in sync as the diagram grows wider.
    editor.store.mergeRemoteChanges(() => {
      editor.updateShape({ id: dState.titleShapeId, type: 'text', props: { w: Math.max(width, 160) } })
    })
  }

  for (const node of diagram.nodes) {
    const box = boxes[node.id]
    const existingId = dState.shapeIds[node.id]

    if (existingId) {
      // layoutDiagram() recomputes a fresh dagre pass over the WHOLE
      // diagram every call, and dagre doesn't produce stable absolute
      // coordinates across separate runs - a node added on this call can
      // easily get assigned a position that an earlier call already used
      // for a different node. Leaving already-drawn shapes frozen at their
      // old position (from the old, now-incompatible coordinate system)
      // was producing literal overlaps once a diagram grew past its first
      // draw. Repositioning every existing shape to the new layout each
      // time keeps the whole diagram internally consistent - existing
      // nodes can visibly shift when the diagram is extended, which is the
      // right tradeoff versus silently overlapping garbage. No stagger:
      // this is a one-time tidy-up, not new content being drawn.
      editor.store.mergeRemoteChanges(() => {
        editor.updateShape({
          id: existingId,
          type: 'geo',
          x: offsetX + box.x,
          y: box.y,
          props: { w: box.w, h: box.h },
        })
      })
      continue
    }

    const id = createShapeId()
    dState.shapeIds[node.id] = id
    dState.schemaIds[id] = node.id
    state.shapeToDiagram[id] = diagram.id

    editor.store.mergeRemoteChanges(() => {
      editor.createShape({
        id,
        type: 'geo',
        x: offsetX + box.x,
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

  for (const edge of diagram.edges ?? []) {
    const key = edgeKey(edge)
    if (dState.drawnEdgeKeys.has(key)) continue

    const fromShapeId = dState.shapeIds[edge.from]
    const toShapeId = dState.shapeIds[edge.to]
    if (!fromShapeId || !toShapeId) continue
    dState.drawnEdgeKeys.add(key)

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
          // Elbow (orthogonal) routing reads far cleaner than straight
          // lines once a diagram has more than a couple of edges - it's
          // what makes a dense node (several edges converging on one box)
          // legible instead of a knot of crossing diagonals.
          kind: 'elbow',
          // Initial points in case binding resolution ever fails - normally
          // overridden visually once the bindings below attach.
          start: { x: offsetX + fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 },
          end: { x: offsetX + toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 },
          richText: toRichText(edge.label ?? ''),
        },
      })

      // Binding by shape id (not raw coordinates) means the arrow follows
      // the box automatically if it's later dragged. snap: 'edge' anchors
      // the elbow route to the shape's edge rather than punching through
      // its center, which is what elbow routing needs to look right.
      editor.createBindings([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: fromShapeId,
          props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'edge' },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: toShapeId,
          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'edge' },
        },
      ])
    })

    await sleep(EDGE_STAGGER_MS)
  }

  await drawReferenceLinks(editor, diagram, state)
}

// Draws a dashed "zooms into / relates to" link from the diagram this one
// elaborates on to this diagram's own title - so a low-level detail view or
// a technical-facet diagram stays visibly connected to what it's about
// without merging the two into one graph. references only ever arrives on
// the turn a diagram is first created (see backend/server.py's
// _new_diagram_from_schema), so this only needs to run once per diagram.
//
// Always anchored title-to-title, even when the reference names a specific
// node - every title sits in the same clear horizontal band above all
// diagram content (y = -TITLE_HEIGHT), so a title-to-title link never has
// to cross through unrelated nodes the way a link into the middle of a
// diagram did. The specific node isn't lost, just no longer drawn as a
// line through the diagram - it's named in the link's own label instead.
async function drawReferenceLinks(editor, diagram, state) {
  const dState = getDiagramState(state, diagram.id)
  if (dState.referencesDrawn) return
  dState.referencesDrawn = true

  const toShapeId = dState.titleShapeId
  if (!toShapeId || !diagram.references?.length) return

  for (const ref of diagram.references) {
    const targetState = getDiagramState(state, ref.diagram_id)
    const fromShapeId = targetState.titleShapeId
    if (!fromShapeId) continue

    const nodeShapeId = ref.node_id ? targetState.shapeIds[ref.node_id] : null
    const nodeShape = nodeShapeId ? editor.getShape(nodeShapeId) : null
    const label = nodeShape
      ? `${REFERENCE_LABEL}: ${renderPlaintextFromRichText(editor, nodeShape.props.richText)}`
      : REFERENCE_LABEL

    const fromBounds = editor.getShapePageBounds(fromShapeId)
    const toBounds = editor.getShapePageBounds(toShapeId)
    if (!fromBounds || !toBounds) continue

    const linkId = createShapeId()
    editor.store.mergeRemoteChanges(() => {
      editor.createShape({
        id: linkId,
        type: 'arrow',
        x: 0,
        y: 0,
        props: {
          // Initial points in case binding resolution ever fails - normally
          // overridden visually once the bindings below attach.
          start: { x: fromBounds.midX, y: fromBounds.midY },
          end: { x: toBounds.midX, y: toBounds.midY },
          color: 'grey',
          dash: 'dashed',
          richText: toRichText(label),
        },
      })
      editor.createBindings([
        {
          type: 'arrow',
          fromId: linkId,
          toId: fromShapeId,
          props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
        },
        {
          type: 'arrow',
          fromId: linkId,
          toId: toShapeId,
          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' },
        },
      ])
    })

    await sleep(EDGE_STAGGER_MS)
  }
}

// Renders a server message onto the tldraw canvas:
//   {action: "extend", diagram} - draws only what's new into that diagram's
//     existing region; every other diagram is left untouched.
//   {action: "new_diagram", diagram} - assigns a fresh region and draws the
//     whole diagram there; every other diagram is left untouched.
//   {action: "replace_all", diagrams} - clears the canvas and (re)draws every
//     diagram fresh. Used for an explicit clear-and-restart, an undo, and
//     the resume-on-reconnect push - the frontend treats all three the same
//     way.
export async function renderSchema(editor, message, state) {
  if (!message) return

  if (message.action === 'replace_all') {
    clearCanvas(editor, state)
    for (const diagram of message.diagrams ?? []) {
      await drawDiagram(editor, diagram, state)
    }
    editor.zoomToFit({ animation: { duration: 300 } })
    return
  }

  if ((message.action === 'extend' || message.action === 'new_diagram') && message.diagram) {
    await drawDiagram(editor, message.diagram, state)
    editor.zoomToFit({ animation: { duration: 300 } })
  }
}
