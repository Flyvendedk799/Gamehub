/**
 * S12 — Scene hierarchy + inspector model for the builder UI.
 *
 * The EditorSession is the source of truth. This module adapts its SceneSummary
 * into a tree the React builder can render, and maps UI gestures back to
 * AgentCommands so agent + human share one undo stack.
 */

export interface HierarchyNode {
  id: string;
  name: string;
  parent: string | null;
  components: readonly string[];
  children: HierarchyNode[];
}

export interface SceneHierarchyModel {
  roots: HierarchyNode[];
  selectedId: string | null;
}

type FlatNode = {
  id: string;
  name: string;
  parent: string | null;
  components: readonly string[];
};

/** Build a forest from a flat EditorSession summary. */
export function buildHierarchy(
  nodes: readonly FlatNode[],
  selectedId: string | null = null,
): SceneHierarchyModel {
  const byId = new Map<string, HierarchyNode>();
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id,
      name: n.name,
      parent: n.parent,
      components: n.components,
      children: [],
    });
  }
  const roots: HierarchyNode[] = [];
  for (const n of byId.values()) {
    if (n.parent && byId.has(n.parent)) {
      byId.get(n.parent)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  return { roots, selectedId };
}

/** Map a drag-to-reparent gesture to the session command. */
export function reparentCommand(
  nodeId: string,
  newParentId: string | null,
): { op: 'scene.setParent'; id: string; parent: string | null } {
  return { op: 'scene.setParent', id: nodeId, parent: newParentId };
}

/** Map an inspector field edit to the session command. */
export function setFieldCommand(
  nodeId: string,
  field: string,
  value: unknown,
): { op: 'scene.setField'; id: string; field: string; value: unknown } {
  return { op: 'scene.setField', id: nodeId, field, value };
}
