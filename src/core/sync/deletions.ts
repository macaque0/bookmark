import type { NormalizedBookmarkNode, PendingBookmarkDeletion } from "../../types/bookmark";

export interface PendingDeletionOptions {
  includeFolders?: boolean;
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

  return tree
    .filter((node) => !matchesAnyDeletion(node, activeDeletions))
    .map((node) => ({
      ...node,
      children: node.children
        ? applyPendingBookmarkDeletions(node.children, activeDeletions, options)
        : undefined
    }));
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

    return true;
  });
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
