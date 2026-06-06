import type { NormalizedBookmarkNode, PendingBookmarkDeletion } from "../../types/bookmark";

export interface FolderFingerprintNode {
  title: string;
  url?: string;
  children?: FolderFingerprintNode[];
}

export interface PendingDeletionOptions {
  includeFolders?: boolean;
}

export function createFolderDeletionFingerprint(node: FolderFingerprintNode): string {
  return JSON.stringify({
    title: node.title,
    children: (node.children ?? [])
      .map((child) => createDeletionNodeFingerprint(child))
      .sort()
  });
}

export function applyPendingBookmarkDeletions(
  tree: NormalizedBookmarkNode[],
  deletions: PendingBookmarkDeletion[],
  options: PendingDeletionOptions = {}
): NormalizedBookmarkNode[] {
  const activeDeletions = options.includeFolders
    ? deletions
    : deletions.filter((deletion) => deletion.type === "bookmark");

  if (activeDeletions.length === 0) {
    return tree;
  }

  const recursivelyFiltered = tree
    .filter((node) => !matchesExactDeletion(node, activeDeletions))
    .map((node) => ({
      ...node,
      children: node.children
        ? applyPendingBookmarkDeletions(node.children, activeDeletions, options)
        : undefined
    }));

  return recursivelyFiltered.filter(
    (node) => !matchesLegacyEmptyFolderDeletion(node, activeDeletions)
  );
}

export function filterPendingDeletionsMissingFromTree(
  deletions: PendingBookmarkDeletion[],
  tree: NormalizedBookmarkNode[],
  options: PendingDeletionOptions = {}
): PendingBookmarkDeletion[] {
  return deletions.filter((deletion) => {
    if (!options.includeFolders && deletion.type === "folder") {
      return false;
    }

    return !treeMatchesDeletion(tree, deletion);
  });
}

function matchesAnyDeletion(
  node: NormalizedBookmarkNode,
  deletions: PendingBookmarkDeletion[]
): boolean {
  return deletions.some((deletion) => {
    if (deletion.type !== node.type || deletion.title !== node.title) {
      return false;
    }

    if (deletion.type === "bookmark") {
      return deletion.url === node.url;
    }

    return deletion.folderFingerprint
      ? deletion.folderFingerprint === createFolderDeletionFingerprint(node)
      : (node.children ?? []).length === 0;
  });
}

function matchesExactDeletion(
  node: NormalizedBookmarkNode,
  deletions: PendingBookmarkDeletion[]
): boolean {
  return deletions.some((deletion) => {
    if (deletion.type !== node.type || deletion.title !== node.title) {
      return false;
    }

    if (deletion.type === "bookmark") {
      return deletion.url === node.url;
    }

    return Boolean(
      deletion.folderFingerprint
      && deletion.folderFingerprint === createFolderDeletionFingerprint(node)
    );
  });
}

function matchesLegacyEmptyFolderDeletion(
  node: NormalizedBookmarkNode,
  deletions: PendingBookmarkDeletion[]
): boolean {
  return (
    node.type === "folder"
    && (node.children ?? []).length === 0
    && deletions.some(
      (deletion) =>
        deletion.type === "folder"
        && deletion.title === node.title
        && !deletion.folderFingerprint
    )
  );
}

function treeMatchesDeletion(
  tree: NormalizedBookmarkNode[],
  deletion: PendingBookmarkDeletion
): boolean {
  return tree.some((node) => {
    if (matchesAnyDeletion(node, [deletion])) {
      return true;
    }

    return treeMatchesDeletion(node.children ?? [], deletion);
  });
}

function createDeletionNodeFingerprint(node: FolderFingerprintNode): string {
  if (node.url) {
    return JSON.stringify({
      title: node.title,
      url: node.url
    });
  }

  return createFolderDeletionFingerprint(node);
}
