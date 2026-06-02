import type { NormalizedBookmarkNode } from "../../types/bookmark";
import { stableId } from "../../utils/uuid";
import { normalizeBrowserRootTitle } from "../bookmarks/normalizeBookmarks";

const OTHER_BOOKMARKS_ROOT_TITLE = "Other Bookmarks";
const KNOWN_BROWSER_ROOT_TITLES = new Set([
  "Bookmarks Bar",
  OTHER_BOOKMARKS_ROOT_TITLE,
  "Bookmarks Menu",
  "Mobile Bookmarks"
]);

export function normalizeSyncTree(
  tree: NormalizedBookmarkNode[],
  managedRootTitle = "S3Marks"
): NormalizedBookmarkNode[] {
  const withoutManagedRoot = removeManagedRootFolders(tree, managedRootTitle);
  const canonicalized = withoutManagedRoot.map((node) => canonicalizeNode(node, true));
  const coalesced = coalesceDuplicateSiblings(canonicalized);
  const rootShaped = moveUnsupportedTopLevelNodes(coalesced);

  return rebaseTree(rootShaped, "");
}

function removeManagedRootFolders(
  tree: NormalizedBookmarkNode[],
  managedRootTitle: string
): NormalizedBookmarkNode[] {
  return tree.flatMap((node) => {
    if (node.type === "folder" && node.title === managedRootTitle) {
      return removeManagedRootFolders(node.children ?? [], managedRootTitle);
    }

    return [
      {
        ...node,
        children: node.children
          ? removeManagedRootFolders(node.children, managedRootTitle)
          : undefined
      }
    ];
  });
}

function canonicalizeNode(
  node: NormalizedBookmarkNode,
  isTopLevel: boolean
): NormalizedBookmarkNode {
  const title =
    isTopLevel && node.type === "folder" ? normalizeBrowserRootTitle(node.title) : node.title;

  return {
    ...node,
    title,
    children: node.children?.map((child) => canonicalizeNode(child, false))
  };
}

function coalesceDuplicateSiblings(
  tree: NormalizedBookmarkNode[]
): NormalizedBookmarkNode[] {
  const nodes = new Map<string, NormalizedBookmarkNode>();

  for (const node of [...tree].sort((left, right) => left.index - right.index)) {
    const key = getSiblingKey(node);
    const existing = nodes.get(key);

    if (existing?.type === "folder" && node.type === "folder") {
      nodes.set(key, {
        ...existing,
        children: coalesceDuplicateSiblings([
          ...(existing.children ?? []),
          ...(node.children ?? [])
        ])
      });
      continue;
    }

    if (!existing) {
      nodes.set(key, {
        ...node,
        children: node.children ? coalesceDuplicateSiblings(node.children) : undefined
      });
    }
  }

  return [...nodes.values()];
}

function getSiblingKey(node: NormalizedBookmarkNode): string {
  return node.type === "folder" ? `folder:${node.title}` : `bookmark:${node.title}:${node.url ?? ""}`;
}

function moveUnsupportedTopLevelNodes(
  tree: NormalizedBookmarkNode[]
): NormalizedBookmarkNode[] {
  const supportedRoots: NormalizedBookmarkNode[] = [];
  const unsupportedNodes: NormalizedBookmarkNode[] = [];

  for (const node of tree) {
    if (isSupportedBrowserRoot(node)) {
      supportedRoots.push(node);
      continue;
    }

    unsupportedNodes.push(node);
  }

  if (unsupportedNodes.length === 0) {
    return supportedRoots;
  }

  const otherRootIndex = supportedRoots.findIndex(
    (node) => node.title === OTHER_BOOKMARKS_ROOT_TITLE
  );

  if (otherRootIndex >= 0) {
    const otherRoot = supportedRoots[otherRootIndex];
    supportedRoots[otherRootIndex] = {
      ...otherRoot,
      children: coalesceDuplicateSiblings([
        ...(otherRoot.children ?? []),
        ...unsupportedNodes
      ])
    };
    return supportedRoots;
  }

  return [
    ...supportedRoots,
    {
      id: stableId(`folder:/${OTHER_BOOKMARKS_ROOT_TITLE}`),
      type: "folder",
      title: OTHER_BOOKMARKS_ROOT_TITLE,
      path: `/${OTHER_BOOKMARKS_ROOT_TITLE}`,
      index: Number.MAX_SAFE_INTEGER,
      children: coalesceDuplicateSiblings(unsupportedNodes)
    }
  ];
}

function isSupportedBrowserRoot(node: NormalizedBookmarkNode): boolean {
  return node.type === "folder" && KNOWN_BROWSER_ROOT_TITLES.has(node.title);
}

function rebaseTree(
  tree: NormalizedBookmarkNode[],
  parentPath: string
): NormalizedBookmarkNode[] {
  return tree
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
        normalized.children = rebaseTree(node.children ?? [], path);
      }

      return normalized;
    });
}
