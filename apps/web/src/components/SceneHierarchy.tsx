'use client';

/**
 * S12 — Scene hierarchy panel for the builder.
 *
 * Client-side model mirrors @playforge/agent-core scene-hierarchy helpers so the
 * web app does not need a hard dependency on agent-core. Gestures emit the same
 * command shapes (scene.setParent / scene.setField) the EditorSession expects.
 */

import { useMemo, useState } from 'react';

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

export function reparentCommand(
  nodeId: string,
  newParentId: string | null,
): { op: 'scene.setParent'; id: string; parent: string | null } {
  return { op: 'scene.setParent', id: nodeId, parent: newParentId };
}

export function setFieldCommand(
  nodeId: string,
  field: string,
  value: unknown,
): { op: 'scene.setField'; id: string; field: string; value: unknown } {
  return { op: 'scene.setField', id: nodeId, field, value };
}

export interface SceneHierarchyPanelProps {
  /** Flat nodes from the live EditorSession / project scene document. */
  nodes?: readonly FlatNode[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onCommand?: (cmd: ReturnType<typeof reparentCommand> | ReturnType<typeof setFieldCommand>) => void;
}

function NodeRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: HierarchyNode;
  depth: number;
  selectedId: string | null;
  onSelect?: (id: string) => void;
}) {
  const selected = node.id === selectedId;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect?.(node.id)}
        className={`flex w-full items-center gap-2 truncate px-2 py-1 text-left text-sm ${
          selected ? 'bg-amber-500/20 text-amber-100' : 'text-zinc-300 hover:bg-zinc-800'
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="truncate font-medium">{node.name}</span>
        {node.components.length > 0 ? (
          <span className="truncate text-xs text-zinc-500">{node.components.join(', ')}</span>
        ) : null}
      </button>
      {node.children.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {node.children.map((child) => (
            <NodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const DEMO_NODES: FlatNode[] = [
  { id: 'root', name: 'Scene', parent: null, components: ['Transform'] },
  { id: 'player', name: 'Player', parent: 'root', components: ['Transform', 'Sprite'] },
  { id: 'camera', name: 'Camera', parent: 'root', components: ['Camera'] },
];

export function SceneHierarchyPanel({
  nodes = DEMO_NODES,
  selectedId: controlledSelected = null,
  onSelect,
  onCommand,
}: SceneHierarchyPanelProps) {
  const [localSelected, setLocalSelected] = useState<string | null>(controlledSelected);
  const selectedId = controlledSelected ?? localSelected;
  const model = useMemo(() => buildHierarchy(nodes, selectedId), [nodes, selectedId]);

  const selected = useMemo(() => {
    const walk = (list: HierarchyNode[]): HierarchyNode | null => {
      for (const n of list) {
        if (n.id === selectedId) return n;
        const hit = walk(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return walk(model.roots);
  }, [model.roots, selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Hierarchy
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
        {model.roots.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            depth={0}
            selectedId={selectedId}
            onSelect={(id) => {
              setLocalSelected(id);
              onSelect?.(id);
            }}
          />
        ))}
      </ul>
      {selected ? (
        <div className="border-t border-zinc-800 p-3 text-sm">
          <div className="mb-2 font-medium">{selected.name}</div>
          <label className="mb-2 block text-xs text-zinc-500">
            Name
            <input
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
              defaultValue={selected.name}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== selected.name) {
                  onCommand?.(setFieldCommand(selected.id, 'name', value));
                }
              }}
            />
          </label>
          <button
            type="button"
            className="text-xs text-zinc-400 underline hover:text-zinc-200"
            onClick={() => onCommand?.(reparentCommand(selected.id, null))}
          >
            Detach (reparent to root)
          </button>
        </div>
      ) : null}
    </div>
  );
}
