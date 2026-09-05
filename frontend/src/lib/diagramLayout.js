import dagre from 'dagre'

const NODE_WIDTH = 160
const NODE_HEIGHT = 60

// Runs dagre layout over the backend's {nodes, edges} schema and returns a
// {x, y, w, h} box per node id, in tldraw's top-left-origin coordinates.
// Kept separate from rendering so the layout engine can be swapped (e.g.
// for ELK) without touching tldraw-specific shape-creation code.
export function layoutSchema(schema) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of schema.nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of schema.edges) {
    g.setEdge(edge.from, edge.to)
  }

  dagre.layout(g)

  const boxes = {}
  for (const node of schema.nodes) {
    const { x, y } = g.node(node.id) // dagre gives center coordinates
    boxes[node.id] = { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2, w: NODE_WIDTH, h: NODE_HEIGHT }
  }
  return boxes
}
