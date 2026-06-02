import type { NormalizedBookmarkNode } from "../../types/bookmark";
import {
  createBookmark,
  createFolder,
  getBrowserBookmarkTree,
  removeBookmarkTree
} from "./browserBookmarks";
import { normalizeBrowserRootTitle } from "./normalizeBookmarks";

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
  const operations = prepareApplyOperations(updates, rootMap);
  const backups = await createRootBackups(operations);
  const touchedRootIds = new Set<string>();

  try {
    for (const operation of operations) {
      touchedRootIds.add(operation.root.id);
      await replaceRootChildren(operation.root.id, operation.children);
    }
  } catch (error) {
    const rollbackErrors = await rollbackTouchedRoots(backups, touchedRootIds);

    if (rollbackErrors.length > 0) {
      throw new Error(
        `写入浏览器书签失败，且自动回滚未完全成功：${formatError(error)}；回滚错误：${rollbackErrors.join("; ")}`
      );
    }

    throw new Error(`写入浏览器书签失败，已恢复同步前的本地书签：${formatError(error)}`);
  }
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

interface ApplyOperation {
  rootTitle: string;
  root: RawBookmarkNode;
  children: NormalizedBookmarkNode[];
}

interface RootBackup {
  rootTitle: string;
  rootId: string;
  children: RawBookmarkNode[];
}

function prepareApplyOperations(
  updates: Map<string, NormalizedBookmarkNode[]>,
  rootMap: Map<string, RawBookmarkNode>
): ApplyOperation[] {
  const operations: ApplyOperation[] = [];

  for (const [rootTitle, children] of updates) {
    const root = rootMap.get(rootTitle) ?? rootMap.get(OTHER_BOOKMARKS_ROOT_TITLE);

    if (!root) {
      throw new Error(`No writable browser bookmark root found for ${rootTitle}.`);
    }

    validateWritableNodes(children, rootTitle);
    operations.push({ rootTitle, root, children });
  }

  return operations;
}

async function createRootBackups(operations: ApplyOperation[]): Promise<Map<string, RootBackup>> {
  const backups = new Map<string, RootBackup>();

  for (const operation of operations) {
    const refreshedRoot = await getVisibleBrowserRootById(operation.root.id);

    if (!refreshedRoot) {
      throw new Error(`No writable browser bookmark root found for ${operation.rootTitle}.`);
    }

    backups.set(operation.root.id, {
      rootTitle: operation.rootTitle,
      rootId: operation.root.id,
      children: cloneRawBookmarkNodes(refreshedRoot.children ?? [])
    });
  }

  return backups;
}

async function rollbackTouchedRoots(
  backups: Map<string, RootBackup>,
  touchedRootIds: Set<string>
): Promise<string[]> {
  const errors: string[] = [];

  for (const rootId of touchedRootIds) {
    const backup = backups.get(rootId);

    if (!backup) {
      continue;
    }

    try {
      await restoreRootBackup(backup);
    } catch (error) {
      errors.push(`${backup.rootTitle}: ${formatError(error)}`);
    }
  }

  return errors;
}

async function restoreRootBackup(backup: RootBackup): Promise<void> {
  await clearRootChildrenById(backup.rootId);

  for (const [index, child] of backup.children.entries()) {
    await createRawBrowserNode(backup.rootId, child, index);
  }
}

async function replaceRootChildren(
  rootId: string,
  children: NormalizedBookmarkNode[]
): Promise<void> {
  await clearRootChildrenById(rootId);

  for (const node of children) {
    await createBrowserNode(rootId, node);
  }
}

async function clearRootChildrenById(rootId: string): Promise<void> {
  const refreshedTree = await getBrowserBookmarkTree();
  const refreshedRoot = getVisibleBrowserRoots(refreshedTree).find((node) => node.id === rootId);

  for (const child of refreshedRoot?.children ?? []) {
    await removeBookmarkTree(child.id);
  }
}

async function getVisibleBrowserRootById(rootId: string): Promise<RawBookmarkNode | null> {
  const refreshedTree = await getBrowserBookmarkTree();
  return getVisibleBrowserRoots(refreshedTree).find((node) => node.id === rootId) ?? null;
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

async function createRawBrowserNode(
  parentId: string,
  node: RawBookmarkNode,
  index: number
): Promise<void> {
  if (node.url) {
    await createBookmark(parentId, node.title, node.url, index);
    return;
  }

  const folderId = await createFolder(parentId, node.title, index);

  for (const [childIndex, child] of (node.children ?? []).entries()) {
    await createRawBrowserNode(folderId, child, childIndex);
  }
}

function validateWritableNodes(nodes: NormalizedBookmarkNode[], rootTitle: string): void {
  for (const node of nodes) {
    if (node.deleted) {
      continue;
    }

    if (node.type === "bookmark" && !node.url) {
      throw new Error(`Cannot write bookmark without URL under ${rootTitle}: ${node.title}`);
    }

    if (node.type === "folder") {
      validateWritableNodes(node.children ?? [], rootTitle);
    }
  }
}

function cloneRawBookmarkNodes(nodes: RawBookmarkNode[]): RawBookmarkNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneRawBookmarkNodes(node.children) : undefined
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
