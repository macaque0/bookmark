import type { NormalizedBookmarkNode } from "../../types/bookmark";
import {
  createBookmark,
  createFolder,
  getBrowserBookmarkTree,
  removeBookmarkTree
} from "./browserBookmarks";
import { normalizeBrowserRootTitle } from "./normalizeBookmarks";

export const MANAGED_ROOT_TITLE = "S3Marks";

type RawBookmarkNode = chrome.bookmarks.BookmarkTreeNode;

const OTHER_BOOKMARKS_ROOT_TITLE = "Other Bookmarks";
const KNOWN_BROWSER_ROOT_TITLES = new Set([
  "Bookmarks Bar",
  OTHER_BOOKMARKS_ROOT_TITLE,
  "Bookmarks Menu",
  "Mobile Bookmarks"
]);

export async function applyBookmarkTree(tree: NormalizedBookmarkNode[]): Promise<void> {
  const rawTree = await getBrowserBookmarkTree();
  const visibleRoots = getVisibleBrowserRoots(rawTree);
  const rootMap = createRootMap(visibleRoots);
  const updates = prepareBrowserRootUpdates(tree, rootMap);

  for (const managedRoot of findManagedRootsInNodes(visibleRoots)) {
    await removeBookmarkTree(managedRoot.id);
  }

  for (const [rootTitle, children] of updates) {
    const root = rootMap.get(rootTitle) ?? rootMap.get(OTHER_BOOKMARKS_ROOT_TITLE);

    if (!root) {
      throw new Error(`No writable browser bookmark root found for ${rootTitle}.`);
    }

    await clearRootChildren(root);

    for (const node of children) {
      await createBrowserNode(root.id, node);
    }
  }
}

export async function findManagedRoot(): Promise<RawBookmarkNode | null> {
  const roots = await findManagedRoots();
  return roots[0] ?? null;
}

export async function findManagedRoots(): Promise<RawBookmarkNode[]> {
  const tree = await getBrowserBookmarkTree();
  return findManagedRootsInNodes(getVisibleBrowserRoots(tree));
}

export function prepareBrowserRootUpdates(
  tree: NormalizedBookmarkNode[],
  rootMap: Map<string, RawBookmarkNode>
): Map<string, NormalizedBookmarkNode[]> {
  const updates = new Map<string, NormalizedBookmarkNode[]>();
  const orphanNodes: NormalizedBookmarkNode[] = [];

  for (const node of tree.filter((item) => !item.deleted)) {
    const canonicalTitle =
      node.type === "folder" ? normalizeBrowserRootTitle(node.title) : node.title;

    if (
      node.type === "folder" &&
      KNOWN_BROWSER_ROOT_TITLES.has(canonicalTitle) &&
      rootMap.has(canonicalTitle)
    ) {
      updates.set(canonicalTitle, (node.children ?? []).filter((child) => !child.deleted));
      continue;
    }

    orphanNodes.push({
      ...node,
      title: canonicalTitle,
      children: node.children?.filter((child) => !child.deleted)
    });
  }

  if (orphanNodes.length > 0) {
    const targetRootTitle = rootMap.has(OTHER_BOOKMARKS_ROOT_TITLE)
      ? OTHER_BOOKMARKS_ROOT_TITLE
      : rootMap.keys().next().value;

    if (targetRootTitle) {
      updates.set(targetRootTitle, [
        ...(updates.get(targetRootTitle) ?? []),
        ...orphanNodes
      ]);
    }
  }

  return updates;
}

function getVisibleBrowserRoots(tree: RawBookmarkNode[]): RawBookmarkNode[] {
  return tree.flatMap((node) => node.children ?? []);
}

function createRootMap(visibleRoots: RawBookmarkNode[]): Map<string, RawBookmarkNode> {
  const rootMap = new Map<string, RawBookmarkNode>();

  for (const root of visibleRoots) {
    const canonicalTitle = normalizeBrowserRootTitle(root.title, root.id);

    if (KNOWN_BROWSER_ROOT_TITLES.has(canonicalTitle) && !rootMap.has(canonicalTitle)) {
      rootMap.set(canonicalTitle, root);
    }
  }

  return rootMap;
}

function findManagedRootsInNodes(nodes: RawBookmarkNode[]): RawBookmarkNode[] {
  const managedRoots: RawBookmarkNode[] = [];

  for (const node of nodes) {
    if (!node.url && node.title === MANAGED_ROOT_TITLE) {
      managedRoots.push(node);
      continue;
    }

    managedRoots.push(...findManagedRootsInNodes(node.children ?? []));
  }

  return managedRoots;
}

async function clearRootChildren(root: RawBookmarkNode): Promise<void> {
  const refreshedTree = await getBrowserBookmarkTree();
  const refreshedRoot = getVisibleBrowserRoots(refreshedTree).find((node) => node.id === root.id);

  for (const child of refreshedRoot?.children ?? []) {
    await removeBookmarkTree(child.id);
  }
}

async function createBrowserNode(parentId: string, node: NormalizedBookmarkNode): Promise<void> {
  if (node.type === "bookmark") {
    await createBookmark(parentId, node.title, node.url ?? "", node.index);
    return;
  }

  const folderId = await createFolder(parentId, node.title, node.index);

  for (const child of node.children ?? []) {
    if (!child.deleted) {
      await createBrowserNode(folderId, child);
    }
  }
}
