import dagre from 'dagre'

const MIN_NODE_WIDTH = 140
const MAX_NODE_WIDTH = 260
const NODE_HEIGHT = 60
const CHAR_WIDTH_ESTIMATE = 8 // rough px/char at the default geo-shape font size
const NODE_PADDING = 32

// Long labels in a fixed-width box either clip or force cramped wrapping
// that eats into the spacing between nodes - sizing the box to the label
// (within sane bounds) gives dagre a truer picture of how much room a node
// actually needs.
function nodeWidthFor(label) {
  const raw = (label?.length ?? 0) * CHAR_WIDTH_ESTIMATE + NODE_PADDING
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, raw))
}

// Runs dagre layout over one diagram's {nodes, edges} and returns a
// {x, y, w, h} box per node id, in that diagram's own local coordinate
// space (top-left origin) - not yet placed on the shared canvas, see
// diagramRender.js's region placement for that. Kept separate from
// rendering so the layout engine can be swapped (e.g. for ELK) without
// touching tldraw-specific shape-creation code.
//
// Spacing is deliberately generous - a diagram that's crowded enough to
// need tighter spacing is a diagram that should have been split (see
// SYSTEM_PROMPT's node-count guidance in backend/pipeline.py) rather than
// one this layout should try to cram in.
export function layoutDiagram(diagram) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 140, edgesep: 30 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of diagram.nodes) {
    g.setNode(node.id, { width: nodeWidthFor(node.label), height: NODE_HEIGHT })
  }
  for (const edge of diagram.edges) {
    g.setEdge(edge.from, edge.to)
  }

  dagre.layout(g)

  const boxes = {}
  let width = 0
  let height = 0
  for (const node of diagram.nodes) {
    const { x, y, width: w } = g.node(node.id) // dagre gives center coordinates
    const box = { x: x - w / 2, y: y - NODE_HEIGHT / 2, w, h: NODE_HEIGHT }
    boxes[node.id] = box
    width = Math.max(width, box.x + box.w)
    height = Math.max(height, box.y + box.h)
  }
  return { boxes, width, height }
}
