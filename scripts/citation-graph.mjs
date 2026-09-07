/** Edges point from a citing paper to a cited paper. Count distinct IDs, never titles. */
export function buildCitationGraph(papers) {
  const byId = new Map(papers.map(paper => [paper.paperId, paper]));
  const edges = new Map();
  const add = (source, target) => {
    if (source !== target && byId.has(source) && byId.has(target)) {
      edges.set(`${source}:${target}`, { source, target });
    }
  };
  for (const paper of byId.values()) {
    for (const reference of paper.references || []) add(paper.paperId, reference?.paperId);
    for (const citation of paper.citations || []) add(citation?.paperId, paper.paperId);
  }
  const links = [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const incoming = new Map([...byId.keys()].map(id => [id, new Set()]));
  for (const edge of links) incoming.get(edge.target).add(edge.source);
  const nodes = [...byId.values()].map(paper => ({
    id: paper.paperId,
    title: paper.title,
    externalIds: paper.externalIds || {},
    publicationDate: paper.publicationDate || null,
    citationCount: incoming.get(paper.paperId).size,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges: links, incoming };
}
