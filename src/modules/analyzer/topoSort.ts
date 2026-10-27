import type { CondensedDAG, TopoLevel } from "../../core/types.js";

/**
 * Computes bottom-up topological levels for the condensed DAG.
 * 
 * - Level 0: Leaf components (no internal dependencies).
 * - Level 1: Components whose dependencies are strictly in Level 0.
 * - Level k: Components whose dependencies are all resolved in levels < k.
 */
export function computeBottomUpTopoLevels(dag: CondensedDAG): {
  levels: TopoLevel[];
  componentLevelMap: Map<string, number>;
} {
  const { components, reverseAdjacencyList } = dag;

  const remainingDependencies = new Map<string, number>();
  const componentLevelMap = new Map<string, number>();
  const queue: string[] = [];

  for (const [compId, comp] of components.entries()) {
    const depCount = comp.dependencies.size;
    remainingDependencies.set(compId, depCount);

    if (depCount === 0) {
      componentLevelMap.set(compId, 0);
      queue.push(compId);
    }
  }

  while (queue.length > 0) {
    const currentCompId = queue.shift()!;
    const currentLevel = componentLevelMap.get(currentCompId) ?? 0;
    const callers = reverseAdjacencyList.get(currentCompId) || new Set();

    for (const callerId of callers) {
      const remaining = (remainingDependencies.get(callerId) ?? 1) - 1;
      remainingDependencies.set(callerId, remaining);

      const existingCallerLevel = componentLevelMap.get(callerId) ?? 0;
      componentLevelMap.set(callerId, Math.max(existingCallerLevel, currentLevel + 1));

      if (remaining === 0) {
        queue.push(callerId);
      }
    }
  }

  for (const compId of components.keys()) {
    if (!componentLevelMap.has(compId)) {
      componentLevelMap.set(compId, 0);
    }
  }

  const maxLevel = Math.max(...Array.from(componentLevelMap.values()), 0);
  const levels: TopoLevel[] = [];

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    levels.push({ level: lvl, components: [] });
  }

  for (const [compId, lvl] of componentLevelMap.entries()) {
    const comp = components.get(compId);
    if (comp) {
      levels[lvl].components.push(comp);
    }
  }

  const filteredLevels = levels.filter((l) => l.components.length > 0);
  return { levels: filteredLevels, componentLevelMap };
}
