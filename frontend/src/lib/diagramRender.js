import { createShapeId, getArrowBindings, renderPlaintextFromRichText, toRichText } from 'tldraw'
import { getIndices } from '@tldraw/utils'
import { layoutDiagram } from './diagramLayout'

const NODE_STAGGER_MS = 150
const EDGE_STAGGER_MS = 100
const DIAGRAM_GUTTER = 200 // horizontal gap between separate diagrams' regions
const TITLE_HEIGHT = 40
const REFERENCE_LABEL = 'zooms into / relates to'
const STRAIGHT_TOLERANCE_PX = 20 // how far a waypoint may sit off the start->end line and still count as "straight"

const MANUAL_DIAGRAM_ID = 'manual'

// Every shape Jarvis draws is tagged `meta.jv` so the shared document alone
// says which diagram/node/edge it belongs to - any participant can then
// rebuild the render state (rebuildRenderState) instead of it living in one
// browser's memory, which is what lets the scribe role move between people
// and lets every client report manual edits correctly:
//   node  (geo):   { d: diagramId, n: nodeId }
//   title (text):  { d: diagramId, t: 1, type: diagramType, refsDone?: 1 }
//   edge shapes:   { d: diagramId, e: "from->to", from: nodeId }
//   reference arrow: { d: diagramId, ref: 1 }
const tag = (meta) => ({ jv: meta })

// Jarvis's draws are ordinary shared edits - tldraw sync only uploads
// source:'user' changes, so (unlike the single-user version) they must NOT
// be wrapped in store.mergeRemoteChanges(). history:'ignore' keeps them out
// of each person's local Ctrl+Z stack; the Undo button goes through the
// backend instead.
function mutate(editor, fn) {
  editor.run(fn, { history: 'ignore' })
}

let renderingCount = 0
// True while a render is in flight - diagramSync.js holds off reporting
// "manual edits" then, since the scribe's own draws look like user edits.
export function isRendering() {
  return renderingCount > 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`
}

// dagre marks a rank crossing with a waypoint even when there's nothing to
// route around, so most edges technically have 3+ points without actually
// bending. Only a route whose middle point(s) sit meaningfully off the
// straight line between its ends needs the non-following routed treatment.
function isEffectivelyStraight(points) {
  if (points.length <= 2) return true
  const start = points[0]
  const end = points[points.length - 1]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  return points.slice(1, -1).every((p) => {
    const distanceFromLine = Math.abs(dy * p.x - dx * p.y + end.x * start.y - end.y * start.x) / length
    return distanceFromLine <= STRAIGHT_TOLERANCE_PX
  })
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
      edgeShapeIds: {}, // edgeKey -> shape id(s) drawn for it, so a later layout pass can redraw it fresh
      edgeSourceNode: {}, // arrow shape id -> schema node id of its TRUE source, for edges whose start isn't bound (see drawEdge)
      titleShapeId: null,
      width: 0,
      title: null,
      diagramType: null,
      referencesDrawn: false,
    }
  }
  return state.diagrams[diagramId]
}

function nearestDiagramId(shape, state) {
  const entries = Object.entries(state.regionOffsets)
  if (!entries.length) return null
  let bestId = null
  let bestDist = Infinity
  for (const [diagramId, offsetX] of entries) {
    const regionWidth = state.diagrams[diagramId]?.width || 0
    const dist = Math.abs(shape.x - (offsetX + regionWidth / 2))
    if (dist < bestDist) {
      bestDist = dist
      bestId = diagramId
    }
  }
  return bestId
}

// Reconstructs the whole render state from the shared document alone (see
// the meta scheme at the top of this file). Called before every render and
// every manual-edit report, so no browser holds state the others lack.
//
// A geo shape without Jarvis meta was drawn by hand: it joins the diagram
// whose region it sits nearest (or a shared catch-all "manual" diagram),
// with a node id derived from its shape id so it's stable across clients.
export function rebuildRenderState(editor) {
  const state = createRenderState()
  const shapes = editor.getCurrentPageShapes()

  for (const shape of shapes) {
    const jv = shape.meta?.jv
    if (shape.type !== 'text' || !jv?.t) continue
    const dState = getDiagramState(state, jv.d)
    dState.titleShapeId = shape.id
    dState.title = renderPlaintextFromRichText(editor, shape.props.richText)
    dState.diagramType = jv.type ?? null
    dState.width = Math.max(dState.width, shape.props.w ?? 0)
    dState.referencesDrawn = !!jv.refsDone
    state.regionOffsets[jv.d] = shape.x
  }
  state.order = Object.keys(state.regionOffsets).sort((a, b) => state.regionOffsets[a] - state.regionOffsets[b])

  for (const shape of shapes) {
    if (shape.type !== 'geo') continue
    const jv = shape.meta?.jv
    let diagramId
    let nodeId
    if (jv?.n) {
      diagramId = jv.d
      nodeId = jv.n
    } else {
      diagramId = nearestDiagramId(shape, state) ?? MANUAL_DIAGRAM_ID
      nodeId = `user_${shape.id.replace('shape:', '')}`
    }
    const dState = getDiagramState(state, diagramId)
    dState.shapeIds[nodeId] = shape.id
    dState.schemaIds[shape.id] = nodeId
    state.shapeToDiagram[shape.id] = diagramId
  }

  for (const shape of shapes) {
    const jv = shape.meta?.jv
    if (jv?.e) {
      const dState = getDiagramState(state, jv.d)
      dState.drawnEdgeKeys.add(jv.e)
      ;(dState.edgeShapeIds[jv.e] ??= []).push(shape.id)
      if (shape.type === 'arrow' && jv.from) dState.edgeSourceNode[shape.id] = jv.from
      continue
    }
    // A hand-drawn arrow between two nodes: register it so a later Jarvis
    // pass replaces it instead of drawing a second arrow on top of it.
    if (shape.type !== 'arrow' || jv) continue
    const bindings = getArrowBindings(editor, shape)
    const toDiagram = bindings.end && state.shapeToDiagram[bindings.end.toId]
    if (!toDiagram) continue
    const dState = getDiagramState(state, toDiagram)
    const toNode = dState.schemaIds[bindings.end.toId]
    const fromNode = bindings.start ? dState.schemaIds[bindings.start.toId] : null
    if (!toNode || !fromNode) continue
    const key = `${fromNode}->${toNode}`
    dState.drawnEdgeKeys.add(key)
    ;(dState.edgeShapeIds[key] ??= []).push(shape.id)
    dState.edgeSourceNode[shape.id] = fromNode
  }

  return state
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
    mutate(editor, () => {
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
  const dState = getDiagramState(state, diagram.id)
  dState.title = diagram.title ?? dState.title
  dState.diagramType = diagram.diagram_type ?? dState.diagramType

  // Jarvis can now remove and rename, not just add (see backend/server.py's
  // _apply_llm_schema) - `diagram` is always the FULL current node/edge
  // list, so anything tracked in dState that's no longer present here was
  // deleted this turn and needs its shape torn down too, not just left
  // orphaned on the canvas.
  const currentNodeIds = new Set(diagram.nodes?.map((n) => n.id))
  const currentEdgeKeys = new Set(diagram.edges?.map((e) => edgeKey(e)))
  const orphanedShapeIds = []
  for (const [nodeId, shapeId] of Object.entries(dState.shapeIds)) {
    if (currentNodeIds.has(nodeId)) continue
    orphanedShapeIds.push(shapeId)
    delete dState.shapeIds[nodeId]
    delete dState.schemaIds[shapeId]
    delete state.shapeToDiagram[shapeId]
  }
  for (const [key, edgeShapeIds] of Object.entries(dState.edgeShapeIds)) {
    if (currentEdgeKeys.has(key)) continue
    orphanedShapeIds.push(...edgeShapeIds)
    for (const id of edgeShapeIds) delete dState.edgeSourceNode[id]
    delete dState.edgeShapeIds[key]
    dState.drawnEdgeKeys.delete(key)
  }
  if (orphanedShapeIds.length) {
    mutate(editor, () => {
      editor.deleteShapes(orphanedShapeIds)
    })
  }

  if (!diagram.nodes?.length) return // everything in this diagram was removed - nothing left to (re)draw

  const { boxes, width, edgePaths } = layoutDiagram(diagram)
  const offsetX = assignRegion(state, diagram.id, width)

  if (dState.titleShapeId === null && diagram.title) {
    const titleId = createShapeId()
    dState.titleShapeId = titleId
    mutate(editor, () => {
      editor.createShape({
        id: titleId,
        type: 'text',
        x: offsetX,
        y: -TITLE_HEIGHT,
        props: { richText: toRichText(diagram.title), w: Math.max(width, 160), autoSize: false },
        meta: tag({ d: diagram.id, t: 1, type: diagram.diagram_type ?? null }),
      })
    })
  } else if (dState.titleShapeId !== null) {
    // Keep the title's width in sync as the diagram grows wider.
    mutate(editor, () => {
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
      mutate(editor, () => {
        editor.updateShape({
          id: existingId,
          type: 'geo',
          x: offsetX + box.x,
          y: box.y,
          // richText is re-set every pass (not just on a real rename) -
          // idempotent when unchanged, and simpler than threading through
          // "did the label actually change" just to skip a cheap no-op.
          props: { w: box.w, h: box.h, richText: toRichText(node.label ?? '') },
        })
      })
      continue
    }

    const id = createShapeId()
    dState.shapeIds[node.id] = id
    dState.schemaIds[id] = node.id
    state.shapeToDiagram[id] = diagram.id

    mutate(editor, () => {
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
        meta: tag({ d: diagram.id, n: node.id }),
      })
    })
    await sleep(NODE_STAGGER_MS)
  }

  for (const edge of diagram.edges ?? []) {
    const key = edgeKey(edge)
    const fromShapeId = dState.shapeIds[edge.from]
    const toShapeId = dState.shapeIds[edge.to]
    if (!fromShapeId || !toShapeId) continue

    const rawPoints = edgePaths[key]
    if (!rawPoints || rawPoints.length < 2) continue
    const points = rawPoints.map((p) => ({ x: offsetX + p.x, y: p.y }))

    const edgeMeta = tag({ d: diagram.id, e: key, from: edge.from })
    const isNew = !dState.drawnEdgeKeys.has(key)
    dState.drawnEdgeKeys.add(key)

    const previousShapeIds = dState.edgeShapeIds[key]
    if (previousShapeIds) {
      // A node moved and dagre re-routed this edge - the point count and
      // path can both change between layout passes, so redraw fresh
      // rather than trying to patch the old shapes. No stagger: this is a
      // one-time tidy-up like the node repositioning above, not new
      // content appearing.
      mutate(editor, () => {
        editor.deleteShapes(previousShapeIds)
      })
      for (const id of previousShapeIds) delete dState.edgeSourceNode[id]
    }

    // dagre inserts an extra waypoint at every rank crossing as an artifact
    // of its algorithm, even for an edge that's really just a straight
    // line - routing THOSE through the unbound line+arrow hybrid below
    // would cost native drag-follow behavior for no actual routing
    // benefit. Only edges that genuinely bend to avoid something use it;
    // anything effectively straight gets a normal, fully-bound arrow so
    // dragging either node keeps it attached, the way tldraw arrows
    // normally behave.
    const shapeIds = isEffectivelyStraight(points)
      ? drawSimpleEdge(editor, fromShapeId, toShapeId, edge.label, edgeMeta)
      : drawRoutedEdge(editor, points, edge.label, toShapeId, edgeMeta)
    dState.edgeShapeIds[key] = shapeIds
    dState.edgeSourceNode[shapeIds[shapeIds.length - 1]] = edge.from

    if (isNew) await sleep(EDGE_STAGGER_MS)
  }

  await drawReferenceLinks(editor, diagram, state)
}

// Draws a normal arrow bound at both ends, the way tldraw arrows work by
// default - the box follows automatically if either end is later dragged.
// Used whenever the route doesn't actually need to bend around anything
// (see isEffectivelyStraight), since binding both ends is strictly better
// than the unbound routed path when there's nothing to route around.
function drawSimpleEdge(editor, fromShapeId, toShapeId, label, meta) {
  const fromBounds = editor.getShapePageBounds(fromShapeId)
  const toBounds = editor.getShapePageBounds(toShapeId)
  const arrowId = createShapeId()
  mutate(editor, () => {
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: 0,
      y: 0,
      props: {
        kind: 'elbow',
        // Initial points in case binding resolution ever fails - normally
        // overridden visually once the bindings below attach.
        start: fromBounds ? { x: fromBounds.midX, y: fromBounds.midY } : { x: 0, y: 0 },
        end: toBounds ? { x: toBounds.midX, y: toBounds.midY } : { x: 100, y: 100 },
        richText: toRichText(label ?? ''),
      },
      meta,
    })
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
  return [arrowId]
}

// Draws one edge along dagre's actual computed route (not just a straight
// or locally-elbowed line between its two endpoints) so it goes around
// other nodes the way dagre's whole-graph layout intended, instead of
// cutting through whatever happens to sit between the two shapes.
//
// tldraw's arrow shape has no concept of a multi-point path (only a single
// optional bend), so the route's body - every waypoint except the last -
// is drawn as an unbound `line` shape (which does support multiple
// points), and only the final short hop into the target is a real bound
// `arrow`, which is what gives the edge its arrowhead and lets it snap
// cleanly onto the target's boundary. That final arrow is deliberately
// bound at its end only, not its start - binding both ends would make
// tldraw recompute a direct point-to-point anchor and undo the routing
// entirely. Returns the created shape ids, source-to-target order (the
// arrow is always last) - diagramSync.js's edgeSourceNode lookup relies on
// that final id to recover the semantic source, since this arrow has no
// start binding to read it from.
function drawRoutedEdge(editor, points, label, toShapeId, meta) {
  const shapeIds = []

  mutate(editor, () => {
    if (points.length > 2) {
      const bodyPoints = points.slice(0, -1)
      const lineId = createShapeId()
      const origin = bodyPoints[0]
      const indices = getIndices(bodyPoints.length)
      const linePoints = {}
      bodyPoints.forEach((p, i) => {
        const id = `p${i}`
        linePoints[id] = { id, index: indices[i], x: p.x - origin.x, y: p.y - origin.y }
      })
      editor.createShape({
        id: lineId,
        type: 'line',
        x: origin.x,
        y: origin.y,
        props: { points: linePoints, spline: 'line' },
        meta,
      })
      shapeIds.push(lineId)
    }

    const secondLast = points[points.length - 2]
    const last = points[points.length - 1]
    const arrowId = createShapeId()
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: 0,
      y: 0,
      props: {
        kind: 'arc',
        bend: 0,
        arrowheadStart: 'none',
        // Fixed start point (the last routed waypoint before the target) -
        // deliberately unbound, see the function comment above.
        start: { x: secondLast.x, y: secondLast.y },
        end: { x: last.x, y: last.y },
        richText: toRichText(label ?? ''),
      },
      meta,
    })
    editor.createBindings([
      {
        type: 'arrow',
        fromId: arrowId,
        toId: toShapeId,
        props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'edge' },
      },
    ])
    shapeIds.push(arrowId)
  })

  return shapeIds
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
  if (dState.titleShapeId) {
    // Persisted on the title so a different scribe doesn't draw the links twice.
    const titleShape = editor.getShape(dState.titleShapeId)
    if (titleShape) {
      mutate(editor, () => {
        editor.updateShape({
          id: titleShape.id,
          type: 'text',
          meta: { ...titleShape.meta, jv: { ...titleShape.meta?.jv, refsDone: 1 } },
        })
      })
    }
  }

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
    mutate(editor, () => {
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
        meta: tag({ d: diagram.id, ref: 1 }),
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

// Renders a server message onto the shared tldraw document:
//   {action: "extend", diagram} - draws only what's new into that diagram's
//     existing region; every other diagram is left untouched.
//   {action: "new_diagram", diagram} - assigns a fresh region and draws the
//     whole diagram there; every other diagram is left untouched.
//   {action: "replace_all", diagrams} - clears the canvas and (re)draws every
//     diagram fresh. Used for an explicit clear-and-restart, an undo, and
//     restoring an empty board - the frontend treats all three the same way.
//
// Only the room's scribe calls this (see App.jsx); everyone else receives the
// resulting shapes through tldraw sync. Messages are queued so two arriving
// back to back can't each rebuild state before the other has drawn.
let renderQueue = Promise.resolve()

export function renderSchema(editor, message) {
  renderQueue = renderQueue.then(() => renderNow(editor, message)).catch((err) => {
    console.error('[render] failed to render', message?.action, err)
  })
  return renderQueue
}

async function renderNow(editor, message) {
  if (!message) return
  renderingCount++
  try {
    const state = rebuildRenderState(editor)

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
  } finally {
    renderingCount--
  }
}

// True when the document already shows what the backend says it should
// (or there's nothing to show) - lets a new scribe skip a full redraw that
// would reset everyone's manual layout tweaks.
export function boardHasDiagrams(editor) {
  return editor.getCurrentPageShapes().some((s) => s.meta?.jv)
}
