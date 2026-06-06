import type { NormalizedBookmarkNode, SyncConflict } from "../../types/bookmark";
import { formatConflictFolderName } from "../../utils/time";
import { stableId } from "../../utils/uuid";
import { nodeSignature } from "./diff";

export interface MergeResult {
  tree: NormalizedBookmarkNode[];
  conflicts: SyncConflict[];
}

export async function mergeBookmarkTrees(
  base: NormalizedBookmarkNode[],
  local: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[]
): Promise<MergeResult> {
  const conflicts: SyncConflict[] = [];
  const merged = mergeChildren(base, local, remote, conflicts);
  const conflictFolder = buildConflictFolder(conflicts);
  const tree = normalizeTreePaths(conflictFolder ? [...merged, conflictFolder] : merged, "");

  return {
    tree,
    conflicts
  };
}

function mergeChildren(
  base: NormalizedBookmarkNode[],
  local: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[],
  conflicts: SyncConflict[]
): NormalizedBookmarkNode[] {
  const baseMap = indexBySiblingKey(base);
  const localMap = indexBySiblingKey(local);
  const remoteMap = indexBySiblingKey(remote);
  const keys = orderedUnionKeys(base, local, remote);
  const merged: NormalizedBookmarkNode[] = [];

  for (const key of keys) {
    const baseNode = baseMap.get(key);
    const localNode = localMap.get(key);
    const remoteNode = remoteMap.get(key);

    if (!baseNode) {
      const added = mergeAddedNodes(localNode, remoteNode, conflicts);

      if (added) {
        merged.push(added);
      }

      continue;
    }

    if (localNode && remoteNode) {
      merged.push(mergeExistingNodes(baseNode, localNode, remoteNode, conflicts));
      continue;
    }

    if (localNode && !remoteNode) {
      if (
        !hasMeaningfulChange(baseNode, localNode)
        || isDeletionOnlyChange(baseNode, localNode)
      ) {
        continue;
      }

      conflicts.push({
        id: stableId(`conflict:remote-delete:${baseNode.path}`),
        reason: "远程删除，本地修改",
        base: cloneNode(baseNode),
        local: cloneNode(localNode)
      });
      merged.push(cloneNode(localNode));
      continue;
    }

    if (!localNode && remoteNode) {
      if (
        !hasMeaningfulChange(baseNode, remoteNode)
        || isDeletionOnlyChange(baseNode, remoteNode)
      ) {
        continue;
      }

      conflicts.push({
        id: stableId(`conflict:local-delete:${baseNode.path}`),
        reason: "本地删除，远程修改",
        base: cloneNode(baseNode),
        remote: cloneNode(remoteNode)
      });
      merged.push(cloneNode(remoteNode));
    }
  }

  return merged.map((node, index) => ({
    ...node,
    index
  }));
}

function mergeAddedNodes(
  localNode: NormalizedBookmarkNode | undefined,
  remoteNode: NormalizedBookmarkNode | undefined,
  conflicts: SyncConflict[]
): NormalizedBookmarkNode | null {
  if (localNode && remoteNode) {
    if (localNode.type === "folder" && remoteNode.type === "folder") {
      return {
        ...cloneNode(localNode),
        children: mergeChildren([], localNode.children ?? [], remoteNode.children ?? [], conflicts)
      };
    }

    return cloneNode(localNode);
  }

  const node = localNode ?? remoteNode;
  return node ? cloneNode(node) : null;
}

function isDeletionOnlyChange(
  baseNode: NormalizedBookmarkNode,
  changedNode: NormalizedBookmarkNode
): boolean {
  if (
    baseNode.type !== changedNode.type
    || baseNode.title !== changedNode.title
    || baseNode.url !== changedNode.url
  ) {
    return false;
  }

  if (baseNode.type === "bookmark" || changedNode.type === "bookmark") {
    return true;
  }

  const baseChildren = indexBySiblingKey(baseNode.children ?? []);

  return (changedNode.children ?? []).every((changedChild) => {
    const baseChild = baseChildren.get(getSiblingKey(changedChild));
    return Boolean(baseChild && isDeletionOnlyChange(baseChild, changedChild));
  });
}

function mergeExistingNodes(
  baseNode: NormalizedBookmarkNode,
  localNode: NormalizedBookmarkNode,
  remoteNode: NormalizedBookmarkNode,
  conflicts: SyncConflict[]
): NormalizedBookmarkNode {
  if (baseNode.type === "folder" && localNode.type === "folder" && remoteNode.type === "folder") {
    return {
      ...cloneNode(localNode),
      children: mergeChildren(
        baseNode.children ?? [],
        localNode.children ?? [],
        remoteNode.children ?? [],
        conflicts
      )
    };
  }

  const localChanged = hasMeaningfulChange(baseNode, localNode);
  const remoteChanged = hasMeaningfulChange(baseNode, remoteNode);

  if (localChanged && remoteChanged && nodeSignature(localNode) !== nodeSignature(remoteNode)) {
    conflicts.push({
      id: stableId(`conflict:both-change:${baseNode.path}`),
      reason: "本地和远程同时修改",
      base: cloneNode(baseNode),
      local: cloneNode(localNode),
      remote: cloneNode(remoteNode)
    });
    return cloneNode(localNode);
  }

  return cloneNode(localChanged ? localNode : remoteNode);
}

function buildConflictFolder(conflicts: SyncConflict[]): NormalizedBookmarkNode | null {
  if (conflicts.length === 0) {
    return null;
  }

  const timestamp = formatConflictFolderName();
  const localChildren = conflicts.map((conflict, index) =>
    conflict.local
      ? prefixConflictTitle(conflict.local, `${index + 1}. ${conflict.reason} - Local`)
      : createDeletedMarker(`${index + 1}. ${conflict.reason} - Local deleted`)
  );
  const remoteChildren = conflicts.map((conflict, index) =>
    conflict.remote
      ? prefixConflictTitle(conflict.remote, `${index + 1}. ${conflict.reason} - Remote`)
      : createDeletedMarker(`${index + 1}. ${conflict.reason} - Remote deleted`)
  );

  return {
    id: stableId(`folder:/Sync Conflicts/${timestamp}`),
    type: "folder",
    title: "Sync Conflicts",
    path: "/Sync Conflicts",
    index: Number.MAX_SAFE_INTEGER,
    children: [
      {
        id: stableId(`folder:/Sync Conflicts/${timestamp}`),
        type: "folder",
        title: timestamp,
        path: `/Sync Conflicts/${timestamp}`,
        index: 0,
        children: [
          {
            id: stableId(`folder:/Sync Conflicts/${timestamp}/Local`),
            type: "folder",
            title: "Local",
            path: `/Sync Conflicts/${timestamp}/Local`,
            index: 0,
            children: localChildren
          },
          {
            id: stableId(`folder:/Sync Conflicts/${timestamp}/Remote`),
            type: "folder",
            title: "Remote",
            path: `/Sync Conflicts/${timestamp}/Remote`,
            index: 1,
            children: remoteChildren
          }
        ]
      }
    ]
  };
}

function prefixConflictTitle(
  node: NormalizedBookmarkNode,
  prefix: string
): NormalizedBookmarkNode {
  const copy = cloneNode(node);

  return {
    ...copy,
    title: `${prefix}: ${copy.title}`,
    children: copy.children?.map((child) => cloneNode(child))
  };
}

function createDeletedMarker(title: string): NormalizedBookmarkNode {
  return {
    id: stableId(`deleted:${title}`),
    type: "folder",
    title,
    path: `/${title}`,
    index: 0,
    children: []
  };
}

function indexBySiblingKey(tree: NormalizedBookmarkNode[]): Map<string, NormalizedBookmarkNode> {
  const map = new Map<string, NormalizedBookmarkNode>();

  for (const node of tree) {
    map.set(getSiblingKey(node), node);
  }

  return map;
}

function orderedUnionKeys(
  base: NormalizedBookmarkNode[],
  local: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[]
): string[] {
  const baseKeys = siblingKeys(base);
  const localKeys = siblingKeys(local);
  const remoteKeys = siblingKeys(remote);
  const localOrderChanged = hasSiblingSequenceChange(baseKeys, localKeys);
  const remoteOrderChanged = hasSiblingSequenceChange(baseKeys, remoteKeys);
  const preferredKeys = remoteOrderChanged
    ? remoteKeys
    : localOrderChanged
      ? localKeys
      : [];
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const key of [
    ...preferredKeys,
    ...defaultUnionKeys(base, local, remote)
  ]) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  return keys;
}

function defaultUnionKeys(
  base: NormalizedBookmarkNode[],
  local: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[]
): string[] {
  return [...base, ...local, ...remote]
    .sort((left, right) => left.index - right.index)
    .map((node) => getSiblingKey(node));
}

function siblingKeys(tree: NormalizedBookmarkNode[]): string[] {
  return [...tree]
    .sort((left, right) => left.index - right.index)
    .map((node) => getSiblingKey(node));
}

function hasSiblingSequenceChange(baseKeys: string[], targetKeys: string[]): boolean {
  return (
    baseKeys.length !== targetKeys.length
    || baseKeys.some((key, index) => key !== targetKeys[index])
  );
}

function getSiblingKey(node: NormalizedBookmarkNode): string {
  return node.type === "folder" ? `folder:${node.title}` : `bookmark:${node.title}:${node.url ?? ""}`;
}

function hasMeaningfulChange(
  baseNode: NormalizedBookmarkNode,
  targetNode: NormalizedBookmarkNode
): boolean {
  return nodeSignature(baseNode) !== nodeSignature(targetNode);
}

function cloneNode<T extends NormalizedBookmarkNode | undefined>(node: T): T {
  if (!node) {
    return node;
  }

  return {
    ...node,
    children: node.children?.map((child) => cloneNode(child))
  } as T;
}

function normalizeTreePaths(
  tree: NormalizedBookmarkNode[],
  parentPath: string
): NormalizedBookmarkNode[] {
  return [...tree]
    .filter((node) => !node.deleted)
    .sort((left, right) => left.index - right.index)
    .map((node, index) => {
      const path = `${parentPath}/${node.title}`.replace(/\/+/g, "/");
      const normalized: NormalizedBookmarkNode = {
        ...node,
        id: stableId(`${node.type}:${path}:${node.url ?? ""}`),
        path,
        index
      };

      if (node.type === "folder") {
        normalized.children = normalizeTreePaths(node.children ?? [], path);
      }

      return normalized;
    });
}
