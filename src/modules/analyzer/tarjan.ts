import type { CodeNode, SCCComponent, CondensedDAG } from "../../core/types.js";

/**
 * Runs Tarjan's Strongly Connected Components algorithm on the directed call graph
 * and condenses the graph into a DAG of SCC components.
 */
export function condenseGraphWithTarjan(nodes: Map<string, CodeNode>): CondensedDAG {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(nodeId: string) {
    indices.set(nodeId, index);
    lowlinks.set(nodeId, index);
    index++;
    stack.push(nodeId);
    onStack.add(nodeId);

    const node = nodes.get(nodeId);
    const neighbors = node ? node.dependencies : [];

    for (const neighborId of neighbors) {
      if (!nodes.has(neighborId)) continue;

      if (!indices.has(neighborId)) {
        strongConnect(neighborId);
        const curLow = lowlinks.get(nodeId)!;
        const nextLow = lowlinks.get(neighborId)!;
        lowlinks.set(nodeId, Math.min(curLow, nextLow));
      } else if (onStack.has(neighborId)) {
        const curLow = lowlinks.get(nodeId)!;
        const nextIndex = indices.get(neighborId)!;
        lowlinks.set(nodeId, Math.min(curLow, nextIndex));
      }
    }

    if (lowlinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w) {
          onStack.delete(w);
          component.push(w);
        }
      } while (w !== nodeId);
      sccs.push(component);
    }
  }

  for (const nodeId of nodes.keys()) {
    if (!indices.has(nodeId)) {
      strongConnect(nodeId);
    }
  }

  const components = new Map<string, SCCComponent>();
  const nodeToComponent = new Map<string, string>();

  sccs.forEach((sccNodeIds, idx) => {
    const compId = `scc_${idx}`;
    const componentNodes: CodeNode[] = [];
    let totalTokens = 0;

    for (const nId of sccNodeIds) {
      nodeToComponent.set(nId, compId);
      const node = nodes.get(nId);
      if (node) {
        componentNodes.push(node);
        totalTokens += node.estimated_tokens;
      }
    }

    let isCyclic = sccNodeIds.length > 1;
    if (!isCyclic && sccNodeIds.length === 1) {
      const singleNode = nodes.get(sccNodeIds[0]);
      if (singleNode && singleNode.dependencies.includes(singleNode.id)) {
        isCyclic = true;
      }
    }

    components.set(compId, {
      id: compId,
      nodeIds: sccNodeIds,
      nodes: componentNodes,
      isCyclic,
      totalTokens,
      dependencies: new Set<string>(),
      dependents: new Set<string>()
    });
  });

  const adjacencyList = new Map<string, Set<string>>();
  const reverseAdjacencyList = new Map<string, Set<string>>();

  for (const compId of components.keys()) {
    adjacencyList.set(compId, new Set());
    reverseAdjacencyList.set(compId, new Set());
  }

  for (const [nodeId, node] of nodes.entries()) {
    const sourceCompId = nodeToComponent.get(nodeId);
    if (!sourceCompId) continue;

    for (const calleeId of node.dependencies) {
      const targetCompId = nodeToComponent.get(calleeId);
      if (!targetCompId) continue;

      if (sourceCompId !== targetCompId) {
        components.get(sourceCompId)!.dependencies.add(targetCompId);
        components.get(targetCompId)!.dependents.add(sourceCompId);

        adjacencyList.get(sourceCompId)!.add(targetCompId);
        reverseAdjacencyList.get(targetCompId)!.add(sourceCompId);
      }
    }
  }

  return {
    components,
    nodeToComponent,
    adjacencyList,
    reverseAdjacencyList
  };
}
