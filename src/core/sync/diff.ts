import type { NormalizedBookmarkNode } from "../../types/bookmark";

export interface BookmarkDiff {
  added: NormalizedBookmarkNode[];
  removed: NormalizedBookmarkNode[];
  changed: NormalizedBookmarkNode[];
  unchanged: NormalizedBookmarkNode[];
}

export function diffBookmarkTrees(
  base: NormalizedBookmarkNode[],
  target: NormalizedBookmarkNode[]
): BookmarkDiff {
  const baseMap = flattenTree(base);
  const targetMap = flattenTree(target);
  const added: NormalizedBookmarkNode[] = [];
  const removed: NormalizedBookmarkNode[] = [];
  const changed: NormalizedBookmarkNode[] = [];
  const unchanged: NormalizedBookmarkNode[] = [];

  for (const [key, targetNode] of targetMap) {
    const baseNode = baseMap.get(key);

    if (!baseNode) {
      added.push(targetNode);
    } else if (nodeSignature(baseNode) !== nodeSignature(targetNode)) {
      changed.push(targetNode);
    } else {
      unchanged.push(targetNode);
    }
  }

  for (const [key, baseNode] of baseMap) {
    if (!targetMap.has(key)) {
      removed.push(baseNode);
    }
  }

  return {
    added,
    removed,
    changed,
    unchanged
  };
}

export function flattenTree(tree: NormalizedBookmarkNode[]): Map<string, NormalizedBookmarkNode> {
  const map = new Map<string, NormalizedBookmarkNode>();

  for (const node of tree) {
    map.set(getNodeIdentity(node), node);

    for (const [key, child] of flattenTree(node.children ?? [])) {
      map.set(key, child);
    }
  }

  return map;
}

export function getNodeIdentity(node: NormalizedBookmarkNode): string {
  return `${node.type}:${node.path}:${node.url ?? ""}`;
}

export function nodeSignature(node: NormalizedBookmarkNode): string {
  return JSON.stringify({
    type: node.type,
    title: node.title,
    url: node.url,
    path: node.path,
    deleted: node.deleted,
    children: (node.children ?? []).map(nodeSignature)
  });
}
