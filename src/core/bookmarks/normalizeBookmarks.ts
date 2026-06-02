import type { NormalizedBookmarkNode } from "../../types/bookmark";
import { stableId } from "../../utils/uuid";

type RawBookmarkNode = Partial<chrome.bookmarks.BookmarkTreeNode> & {
  children?: RawBookmarkNode[];
};

const ROOT_ID_TITLE_MAP = new Map<string, string>([
  ["toolbar_____", "Bookmarks Bar"],
  ["menu________", "Bookmarks Menu"],
  ["unfiled_____", "Other Bookmarks"],
  ["mobile______", "Mobile Bookmarks"]
]);

const ROOT_TITLE_MAP = new Map<string, string>([
  ["bookmarks bar", "Bookmarks Bar"],
  ["bookmarks toolbar", "Bookmarks Bar"],
  ["favorites bar", "Bookmarks Bar"],
  ["书签栏", "Bookmarks Bar"],
  ["收藏夹栏", "Bookmarks Bar"],
  ["other bookmarks", "Other Bookmarks"],
  ["other favorites", "Other Bookmarks"],
  ["其他书签", "Other Bookmarks"],
  ["其他收藏夹", "Other Bookmarks"],
  ["bookmarks menu", "Bookmarks Menu"],
  ["mobile bookmarks", "Mobile Bookmarks"],
  ["移动设备书签", "Mobile Bookmarks"]
]);

export function normalizeBookmarkTree(rawTree: unknown[]): NormalizedBookmarkNode[] {
  const roots = rawTree as RawBookmarkNode[];

  return roots.flatMap((node) => normalizeRootNode(node));
}

export function countBookmarks(tree: NormalizedBookmarkNode[]): number {
  return tree.reduce((total, node) => {
    const self = node.type === "bookmark" && !node.deleted ? 1 : 0;
    return total + self + countBookmarks(node.children ?? []);
  }, 0);
}

export function countFolders(tree: NormalizedBookmarkNode[]): number {
  return tree.reduce((total, node) => {
    const self = node.type === "folder" && !node.deleted ? 1 : 0;
    return total + self + countFolders(node.children ?? []);
  }, 0);
}

export function sortTreeByIndex(tree: NormalizedBookmarkNode[]): NormalizedBookmarkNode[] {
  return [...tree]
    .sort((left, right) => left.index - right.index)
    .map((node) => ({
      ...node,
      children: node.children ? sortTreeByIndex(node.children) : undefined
    }));
}

function normalizeRootNode(node: RawBookmarkNode): NormalizedBookmarkNode[] {
  if (isInvisibleBrowserRoot(node)) {
    return (node.children ?? []).flatMap((child, index) =>
      normalizeChildNode(child, "", index, true)
    );
  }

  return normalizeChildNode(node, "", node.index ?? 0, true);
}

function normalizeChildNode(
  node: RawBookmarkNode,
  parentPath: string,
  fallbackIndex: number,
  isTopLevel: boolean
): NormalizedBookmarkNode[] {
  const type = node.url ? "bookmark" : "folder";
  const title = normalizeTitle(node, isTopLevel);

  const index = node.index ?? fallbackIndex;
  const path = buildPath(parentPath, title);
  const normalized: NormalizedBookmarkNode = {
    id: stableId(`${type}:${path}:${node.url ?? ""}`),
    type,
    title,
    path,
    index,
    createdAt: normalizeBookmarkDate(node.dateAdded),
    updatedAt: normalizeBookmarkDate(node.dateGroupModified)
  };

  if (type === "bookmark") {
    normalized.url = node.url ?? "";
  } else {
    normalized.children = (node.children ?? []).flatMap((child, childIndex) =>
      normalizeChildNode(child, path, childIndex, false)
    );
  }

  return [normalized];
}

function isInvisibleBrowserRoot(node: RawBookmarkNode): boolean {
  return !node.url && (!node.title || node.id === "0" || node.id === "root________");
}

function normalizeTitle(node: RawBookmarkNode, isTopLevel: boolean): string {
  const rawTitle = (node.title ?? "").trim();

  if (isTopLevel) {
    return normalizeBrowserRootTitle(rawTitle, node.id);
  }

  return rawTitle || "Untitled";
}

export function normalizeBrowserRootTitle(title: string, id?: string): string {
  const rawTitle = title.trim();
  const mappedById = id ? ROOT_ID_TITLE_MAP.get(id) : undefined;
  const mappedByTitle = ROOT_TITLE_MAP.get(rawTitle.toLowerCase());

  return (mappedById ?? mappedByTitle ?? rawTitle) || "Untitled";
}

function normalizeBookmarkDate(value?: number): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Date(value).toISOString();
}

function buildPath(parentPath: string, title: string): string {
  return `${parentPath}/${title}`.replace(/\/+/g, "/");
}
