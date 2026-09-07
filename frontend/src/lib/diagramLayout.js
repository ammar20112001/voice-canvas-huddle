import dagre from 'dagre'

const NODE_WIDTH = 160
const NODE_HEIGHT = 60

// Runs dagre layout over one diagram's {nodes, edges} and returns a
// {x, y, w, h} box per node id, in that diagram's own local coordinate
// space (top-left origin) - not yet placed on the shared canvas, see
// diagramRender.js's region placement for that. Kept separate from
// rendering so the layout engine can be swapped (e.g. for ELK) without
// touching tldraw-specific shape-creation code.
export function layoutDiagram(diagram) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of diagram.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of diagram.edges) {
    g.setEdge(edge.from, edge.to)
  }

  dagre.layout(g)

  const boxes = {}
  let width = 0
  let height = 0
  for (const node of diagram.nodes) {
    const { x, y } = g.node(node.id) // dagre gives center coordinates
    const box = { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT }
    boxes[node.id] = box
    width = Math.max(width, box.x + box.w)
    height = Math.max(height, box.y + box.h)
  }
  return { boxes, width, height }
}
