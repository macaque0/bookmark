import assert from "node:assert/strict";
import type {
  NormalizedBookmarkNode,
  PendingBookmarkDeletion,
  SyncFile,
  SyncMetadata
} from "../src/types/bookmark";
import {
  prepareBrowserRootUpdates,
  prepareWritableBookmarkNodes
} from "../src/core/bookmarks/applyBookmarkTree";
import { normalizeBookmarkTree } from "../src/core/bookmarks/normalizeBookmarks";
import {
  getBookmarkEventDecision,
  getDeferredBookmarkChangeDelayMinutes
} from "../src/background/eventGate";
import {
  applyPendingBookmarkDeletions,
  createFolderDeletionFingerprint
} from "../src/core/sync/deletions";
import {
  chooseLegacyLatestSyncFile,
  getMetadataWriteOptions,
  getMetadataLatestKey,
  getStaleLatestKey,
  isEncryptedLatestKey,
  isSameSyncMetadata,
  LATEST_ENCRYPTED_KEY,
  LATEST_JSON_KEY,
  shouldUsePlaintextBeforeEncrypted
} from "../src/core/sync/latestObject";
import { mergeBookmarkTrees } from "../src/core/sync/merge";
import { normalizeSyncTree } from "../src/core/sync/tree";
import { formatRevisionFileName } from "../src/utils/time";

function bookmark(title: string, url: string, index: number): chrome.bookmarks.BookmarkTreeNode {
  return {
    id: `${title}-${index}`,
    title,
    url,
    index,
    parentId: "parent"
  };
}

function folder(
  title: string,
  children: chrome.bookmarks.BookmarkTreeNode[],
  index: number,
  id = title
): chrome.bookmarks.BookmarkTreeNode {
  return {
    id,
    title,
    index,
    parentId: "root",
    children
  };
}

function browserTree(children: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  return [
    {
      id: "0",
      title: "",
      children
    }
  ];
}

function titles(tree: NormalizedBookmarkNode[]): string[] {
  const result: string[] = [];

  for (const node of tree) {
    result.push(node.path);
    result.push(...titles(node.children ?? []));
  }

  return result;
}

function childTitlesAtPath(
  tree: NormalizedBookmarkNode[],
  path: string
): string[] {
  const node = findNodeByPath(tree, path);
  return (node?.children ?? []).map((child) => child.title);
}

function findNodeByPath(
  tree: NormalizedBookmarkNode[],
  path: string
): NormalizedBookmarkNode | null {
  for (const node of tree) {
    if (node.path === path) {
      return node;
    }

    const child = findNodeByPath(node.children ?? [], path);

    if (child) {
      return child;
    }
  }

  return null;
}

function syncFile(revision: number): SyncFile {
  return {
    schemaVersion: 1,
    revision,
    deviceId: `device-${revision}`,
    updatedAt: `2026-06-02T00:00:0${revision}.000Z`,
    tree: []
  };
}

function testS3MarksFolderIsPreserved() {
  const tree = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder(
          "其他收藏夹",
          [
            folder("S3Marks", [bookmark("Project", "https://project.example", 0)], 0)
          ],
          0
        )
      ])
    )
  );
  const allTitles = titles(tree);

  assert.ok(allTitles.includes("/Other Bookmarks/S3Marks"));
  assert.ok(allTitles.includes("/Other Bookmarks/S3Marks/Project"));
}

async function testS3MarksFolderMergesLikeNormalUserFolder() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("其他收藏夹", [folder("S3Marks", [], 0)], 0)
      ])
    )
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder(
          "其他收藏夹",
          [
            folder("S3Marks", [bookmark("Local", "https://local.example", 0)], 0)
          ],
          0
        )
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder(
          "其他收藏夹",
          [
            folder("S3Marks", [bookmark("Remote", "https://remote.example", 0)], 0)
          ],
          0
        )
      ])
    )
  );
  const merged = await mergeBookmarkTrees(base, local, remote);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Other Bookmarks/S3Marks/Local"));
  assert.ok(mergedTitles.includes("/Other Bookmarks/S3Marks/Remote"));
}

async function testStaleChineseBaseDoesNotDeleteRemote() {
  const staleBase = normalizeBookmarkTree(
    browserTree([
      folder("收藏夹栏", [bookmark("A", "https://a.example", 0)], 0)
    ])
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("A", "https://a.example", 0),
          bookmark("B", "https://b.example", 1)
        ], 0)
      ])
    )
  );
  const merged = await mergeBookmarkTrees(normalizeSyncTree(staleBase), local, remote);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/A"));
  assert.ok(mergedTitles.includes("/Bookmarks Bar/B"));
}

async function testLocalAdditionsSurviveStaleRemote() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [
          bookmark("A", "https://a.example", 0),
          bookmark("Chrome New 1", "https://chrome-new-1.example", 1),
          bookmark("Chrome New 2", "https://chrome-new-2.example", 2)
        ], 0)
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const merged = await mergeBookmarkTrees(base, local, remote);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/Chrome New 1"));
  assert.ok(mergedTitles.includes("/Bookmarks Bar/Chrome New 2"));
}

async function testLocalDeletionSurvivesStaleRemote() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [
          bookmark("A", "https://a.example", 0),
          bookmark("Delete Me", "https://delete.example", 1)
        ], 0)
      ])
    )
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("A", "https://a.example", 0),
          bookmark("Delete Me", "https://delete.example", 1)
        ], 0)
      ])
    )
  );
  const merged = await mergeBookmarkTrees(base, local, remote);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/A"));
  assert.equal(mergedTitles.includes("/Bookmarks Bar/Delete Me"), false);
}

async function testPendingDeletionPreventsResurrectionWithoutBase() {
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("A", "https://a.example", 0),
          bookmark("Delete Me", "https://delete.example", 1)
        ], 0)
      ])
    )
  );
  const deletions: PendingBookmarkDeletion[] = [
    {
      id: "delete-1",
      createdAt: "2026-06-05T00:00:00.000Z",
      type: "bookmark",
      title: "Delete Me",
      url: "https://delete.example"
    }
  ];
  const remoteAfterDeletion = applyPendingBookmarkDeletions(remote, deletions);
  const merged = await mergeBookmarkTrees([], local, remoteAfterDeletion);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/A"));
  assert.equal(mergedTitles.includes("/Bookmarks Bar/Delete Me"), false);
}

async function testPendingBookmarkDeletionPreventsResurrectionWithMismatchedBase() {
  const staleBase = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [bookmark("A", "https://a.example", 0)], 0)
      ])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("A", "https://a.example", 0),
          bookmark("Delete Me", "https://delete.example", 1)
        ], 0)
      ])
    )
  );
  const deletions: PendingBookmarkDeletion[] = [
    {
      id: "delete-2",
      createdAt: "2026-06-05T00:00:00.000Z",
      type: "bookmark",
      title: "Delete Me",
      url: "https://delete.example"
    }
  ];
  const remoteAfterDeletion = applyPendingBookmarkDeletions(remote, deletions);
  const merged = await mergeBookmarkTrees(staleBase, local, remoteAfterDeletion);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/A"));
  assert.equal(mergedTitles.includes("/Bookmarks Bar/Delete Me"), false);
}

async function testPendingFolderDeletionRemovesOnlyMatchingSubtree() {
  const deletedFolder = folder("Delete Folder", [
    bookmark("A", "https://a.example", 0),
    bookmark("B", "https://b.example", 1)
  ], 0);
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Project A", [deletedFolder], 0),
          folder("Project B", [
            folder("Delete Folder", [bookmark("Keep", "https://keep.example", 0)], 0)
          ], 1)
        ], 0)
      ])
    )
  );
  const deletions: PendingBookmarkDeletion[] = [
    {
      id: "delete-folder",
      createdAt: "2026-06-06T00:00:00.000Z",
      type: "folder",
      title: "Delete Folder",
      folderFingerprint: createFolderDeletionFingerprint(deletedFolder)
    }
  ];
  const result = applyPendingBookmarkDeletions(remote, deletions, {
    includeFolders: true
  });
  const resultTitles = titles(result);
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Project A", [], 0),
          folder("Project B", [
            folder("Delete Folder", [bookmark("Keep", "https://keep.example", 0)], 0)
          ], 1)
        ], 0)
      ])
    )
  );
  const merged = await mergeBookmarkTrees(remote, local, result);

  assert.equal(resultTitles.includes("/Bookmarks Bar/Project A/Delete Folder"), false);
  assert.ok(resultTitles.includes("/Bookmarks Bar/Project B/Delete Folder/Keep"));
  assert.equal(merged.conflicts.length, 0);
  assert.equal(titles(merged.tree).includes("/Bookmarks Bar/Project A/Delete Folder"), false);
}

function testLegacyFolderDeletionRemovesEmptyShellAfterChildren() {
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Delete Folder", [bookmark("A", "https://a.example", 0)], 0)
        ], 0)
      ])
    )
  );
  const deletions: PendingBookmarkDeletion[] = [
    {
      id: "legacy-folder",
      createdAt: "2026-06-06T00:00:00.000Z",
      type: "folder",
      title: "Delete Folder"
    },
    {
      id: "legacy-child",
      createdAt: "2026-06-06T00:00:00.000Z",
      type: "bookmark",
      title: "A",
      url: "https://a.example"
    }
  ];
  const result = applyPendingBookmarkDeletions(remote, deletions, {
    includeFolders: true
  });

  assert.equal(titles(result).includes("/Bookmarks Bar/Delete Folder"), false);
}

async function testFolderDeletionWinsAgainstRemoteChildDeletions() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Delete Folder", [
            bookmark("A", "https://a.example", 0),
            bookmark("B", "https://b.example", 1)
          ], 0)
        ], 0)
      ])
    )
  );
  const local = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([folder("Bookmarks Bar", [], 0)])
    )
  );
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [folder("Delete Folder", [], 0)], 0)
      ])
    )
  );
  const merged = await mergeBookmarkTrees(base, local, remote);

  assert.equal(merged.conflicts.length, 0);
  assert.equal(titles(merged.tree).includes("/Bookmarks Bar/Delete Folder"), false);
}

function testWritableBookmarkIndexesAreSequential() {
  const writable = prepareWritableBookmarkNodes([
    {
      id: "folder",
      type: "folder",
      title: "Folder",
      path: "/Folder",
      index: Number.MAX_SAFE_INTEGER,
      children: [
        {
          id: "bookmark-b",
          type: "bookmark",
          title: "B",
          url: "https://b.example",
          path: "/Folder/B",
          index: Number.MAX_SAFE_INTEGER
        },
        {
          id: "bookmark-a",
          type: "bookmark",
          title: "A",
          url: "https://a.example",
          path: "/Folder/A",
          index: 12
        }
      ]
    }
  ]);

  assert.equal(writable[0].index, 0);
  assert.deepEqual(writable[0].children?.map((node) => node.index), [0, 1]);
}

async function testFolderReorderPropagatesAcrossBrowsers() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Folder A", [], 0),
          folder("Folder B", [], 1)
        ], 0)
      ])
    )
  );
  const chromeLocal = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Folder B", [], 0),
          folder("Folder A", [], 1)
        ], 0)
      ])
    )
  );
  const uploaded = await mergeBookmarkTrees(base, chromeLocal, base);
  const edgeMerged = await mergeBookmarkTrees(base, base, uploaded.tree);

  assert.deepEqual(
    childTitlesAtPath(uploaded.tree, "/Bookmarks Bar"),
    ["Folder B", "Folder A"]
  );
  assert.deepEqual(
    childTitlesAtPath(edgeMerged.tree, "/Bookmarks Bar"),
    ["Folder B", "Folder A"]
  );
}

async function testBookmarkReorderPropagatesAcrossBrowsers() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("A", "https://a.example", 0),
          bookmark("B", "https://b.example", 1)
        ], 0)
      ])
    )
  );
  const chromeLocal = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          bookmark("B", "https://b.example", 0),
          bookmark("A", "https://a.example", 1)
        ], 0)
      ])
    )
  );
  const uploaded = await mergeBookmarkTrees(base, chromeLocal, base);
  const edgeMerged = await mergeBookmarkTrees(base, base, uploaded.tree);

  assert.deepEqual(
    childTitlesAtPath(uploaded.tree, "/Bookmarks Bar"),
    ["B", "A"]
  );
  assert.deepEqual(
    childTitlesAtPath(edgeMerged.tree, "/Bookmarks Bar"),
    ["B", "A"]
  );
}

async function testBookmarkMoveAcrossFoldersPropagates() {
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Source", [bookmark("Move Me", "https://move.example", 0)], 0),
          folder("Target", [], 1)
        ], 0)
      ])
    )
  );
  const moved = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Source", [], 0),
          folder("Target", [bookmark("Move Me", "https://move.example", 0)], 1)
        ], 0)
      ])
    )
  );
  const uploaded = await mergeBookmarkTrees(base, moved, base);
  const edgeMerged = await mergeBookmarkTrees(base, base, uploaded.tree);
  const edgeTitles = titles(edgeMerged.tree);

  assert.equal(edgeTitles.includes("/Bookmarks Bar/Source/Move Me"), false);
  assert.ok(edgeTitles.includes("/Bookmarks Bar/Target/Move Me"));
}

async function testFolderMoveAcrossParentsPropagates() {
  const movingFolder = folder(
    "Move Folder",
    [bookmark("A", "https://a.example", 0)],
    0
  );
  const base = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Source", [movingFolder], 0),
          folder("Target", [], 1)
        ], 0)
      ])
    )
  );
  const moved = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [
          folder("Source", [], 0),
          folder("Target", [movingFolder], 1)
        ], 0)
      ])
    )
  );
  const uploaded = await mergeBookmarkTrees(base, moved, base);
  const edgeMerged = await mergeBookmarkTrees(base, base, uploaded.tree);
  const edgeTitles = titles(edgeMerged.tree);

  assert.equal(edgeTitles.includes("/Bookmarks Bar/Source/Move Folder"), false);
  assert.ok(edgeTitles.includes("/Bookmarks Bar/Target/Move Folder/A"));
}

function testRootTitleCanonicalization() {
  const tree = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [bookmark("A", "https://a.example", 0)], 0),
        folder("Bookmarks Bar", [bookmark("B", "https://b.example", 0)], 1),
        folder("其他收藏夹", [bookmark("C", "https://c.example", 0)], 2),
        folder("Other Bookmarks", [bookmark("D", "https://d.example", 0)], 3)
      ])
    )
  );
  const allTitles = titles(tree);

  assert.equal(tree.length, 2);
  assert.ok(allTitles.includes("/Bookmarks Bar/A"));
  assert.ok(allTitles.includes("/Bookmarks Bar/B"));
  assert.ok(allTitles.includes("/Other Bookmarks/C"));
  assert.ok(allTitles.includes("/Other Bookmarks/D"));
}

function testTopLevelS3MarksIsNotMigrated() {
  const tree = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder(
          "S3Marks",
          [
            folder("Bookmarks Bar", [bookmark("Remote A", "https://remote.example", 0)], 0)
          ],
          0
        )
      ])
    )
  );
  const allTitles = titles(tree);

  assert.equal(allTitles.includes("/Bookmarks Bar/Remote A"), false);
  assert.ok(allTitles.includes("/Other Bookmarks/S3Marks/Bookmarks Bar/Remote A"));
}

function testNativeRootUpdatePlanDoesNotCreateManagedRoot() {
  const rootMap = new Map<string, chrome.bookmarks.BookmarkTreeNode>([
    ["Bookmarks Bar", folder("收藏夹栏", [], 0, "1")],
    ["Other Bookmarks", folder("其他收藏夹", [], 1, "2")]
  ]);
  const tree = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("Bookmarks Bar", [bookmark("A", "https://a.example", 0)], 0),
        folder("S3Marks", [bookmark("Project", "https://project.example", 0)], 1)
      ])
    )
  );
  const updates = prepareBrowserRootUpdates(tree, rootMap);

  assert.equal(updates.has("S3Marks"), false);
  assert.ok(updates.get("Bookmarks Bar")?.some((node) => node.title === "A"));
  assert.ok(updates.get("Other Bookmarks")?.some((node) => node.title === "S3Marks"));
}

function testEncryptionMetadataSelectsActiveLatestObject() {
  const plaintextMetadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 3,
    latestUpdatedAt: "2026-06-02T00:00:03.000Z",
    latestDeviceId: "device-3",
    latestObjectKey: LATEST_JSON_KEY,
    latestEncrypted: false
  };
  const encryptedMetadata: SyncMetadata = {
    ...plaintextMetadata,
    latestRevision: 4,
    latestObjectKey: LATEST_ENCRYPTED_KEY,
    latestEncrypted: true
  };

  assert.equal(getMetadataLatestKey(plaintextMetadata), LATEST_JSON_KEY);
  assert.equal(isEncryptedLatestKey(LATEST_JSON_KEY, plaintextMetadata), false);
  assert.equal(getMetadataLatestKey(encryptedMetadata), LATEST_ENCRYPTED_KEY);
  assert.equal(isEncryptedLatestKey(LATEST_ENCRYPTED_KEY, encryptedMetadata), true);
  assert.equal(getStaleLatestKey(LATEST_JSON_KEY), LATEST_ENCRYPTED_KEY);
  assert.equal(getStaleLatestKey(LATEST_ENCRYPTED_KEY), LATEST_JSON_KEY);
}

function testMetadataCanPointToImmutableHistoryObject() {
  const plaintextHistoryMetadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 9,
    latestUpdatedAt: "2026-06-02T00:00:09.000Z",
    latestDeviceId: "device-9",
    latestObjectKey: "history/000009-device-9.json",
    latestEncrypted: false
  };
  const encryptedHistoryMetadata: SyncMetadata = {
    ...plaintextHistoryMetadata,
    latestObjectKey: "history/000010-device-10.json.enc",
    latestEncrypted: true
  };

  assert.equal(getMetadataLatestKey(plaintextHistoryMetadata), "history/000009-device-9.json");
  assert.equal(getMetadataLatestKey(encryptedHistoryMetadata), "history/000010-device-10.json.enc");
  assert.equal(formatRevisionFileName(11, false, "device:with unsafe/chars"), "history/000011-devicewithunsafechars.json");
  assert.equal(formatRevisionFileName(12, true, "device-12"), "history/000012-device-12.json.enc");
}

function testLegacyMetadataDoesNotPreferStaleEncryptedLatest() {
  const metadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 5,
    latestUpdatedAt: "2026-06-02T00:00:05.000Z",
    latestDeviceId: "device-5"
  };

  assert.equal(shouldUsePlaintextBeforeEncrypted(metadata, syncFile(5)), true);
}

function testLegacyLatestSelectionUsesMetadataRevision() {
  const metadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 7,
    latestUpdatedAt: "2026-06-02T00:00:07.000Z",
    latestDeviceId: "device-7"
  };
  const selected = chooseLegacyLatestSyncFile(metadata, [
    { key: LATEST_JSON_KEY, syncFile: syncFile(6) },
    { key: LATEST_ENCRYPTED_KEY, syncFile: syncFile(7) }
  ]);

  assert.equal(selected?.revision, 7);
}

function testLegacyLatestSelectionFallsBackToHighestRevision() {
  const selected = chooseLegacyLatestSyncFile(null, [
    { key: LATEST_JSON_KEY, syncFile: syncFile(8) },
    { key: LATEST_ENCRYPTED_KEY, syncFile: syncFile(6) }
  ]);

  assert.equal(selected?.revision, 8);
}

function testMetadataWriteOptionsHandleMissingETag() {
  const metadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 1,
    latestUpdatedAt: "2026-06-05T00:00:00.000Z",
    latestDeviceId: "device"
  };

  assert.deepEqual(getMetadataWriteOptions({ metadata: null, eTag: null }), {
    ifNoneMatch: "*"
  });
  assert.deepEqual(getMetadataWriteOptions({ metadata, eTag: "\"etag-1\"" }), {
    ifMatch: "\"etag-1\""
  });
  assert.deepEqual(getMetadataWriteOptions({ metadata, eTag: null }), {});
}

function testMetadataVerificationRequiresExactPointer() {
  const expected: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: 78,
    latestUpdatedAt: "2026-06-05T08:45:40.000Z",
    latestDeviceId: "chrome",
    latestObjectKey: "history/000078-chrome.json",
    latestEncrypted: false
  };

  assert.equal(isSameSyncMetadata(expected, { ...expected }), true);
  assert.equal(isSameSyncMetadata(expected, { ...expected, latestRevision: 77 }), false);
  assert.equal(
    isSameSyncMetadata(expected, {
      ...expected,
      latestObjectKey: "history/000078-edge.json"
    }),
    false
  );
  assert.equal(isSameSyncMetadata(expected, null), false);
}

function testBookmarkEventGateDefersPostApplyEvents() {
  assert.equal(
    getBookmarkEventDecision(
      { applyingSyncedBookmarks: true, suppressBookmarkEventsUntil: 1_000 },
      500
    ),
    "ignore"
  );
  assert.equal(
    getBookmarkEventDecision(
      { applyingSyncedBookmarks: false, suppressBookmarkEventsUntil: 1_000 },
      500
    ),
    "defer"
  );
  assert.equal(
    getBookmarkEventDecision(
      { applyingSyncedBookmarks: false, suppressBookmarkEventsUntil: 1_000 },
      1_000
    ),
    "handle"
  );
  assert.equal(getDeferredBookmarkChangeDelayMinutes(61_000, 0.25, 1_000), 1);
  assert.equal(getDeferredBookmarkChangeDelayMinutes(2_000, 0.25, 1_000), 0.25);
}

testS3MarksFolderIsPreserved();
await testS3MarksFolderMergesLikeNormalUserFolder();
await testStaleChineseBaseDoesNotDeleteRemote();
await testLocalAdditionsSurviveStaleRemote();
await testLocalDeletionSurvivesStaleRemote();
await testPendingDeletionPreventsResurrectionWithoutBase();
await testPendingBookmarkDeletionPreventsResurrectionWithMismatchedBase();
await testPendingFolderDeletionRemovesOnlyMatchingSubtree();
testLegacyFolderDeletionRemovesEmptyShellAfterChildren();
await testFolderDeletionWinsAgainstRemoteChildDeletions();
testWritableBookmarkIndexesAreSequential();
await testFolderReorderPropagatesAcrossBrowsers();
await testBookmarkReorderPropagatesAcrossBrowsers();
await testBookmarkMoveAcrossFoldersPropagates();
await testFolderMoveAcrossParentsPropagates();
testRootTitleCanonicalization();
testTopLevelS3MarksIsNotMigrated();
testNativeRootUpdatePlanDoesNotCreateManagedRoot();
testEncryptionMetadataSelectsActiveLatestObject();
testMetadataCanPointToImmutableHistoryObject();
testLegacyMetadataDoesNotPreferStaleEncryptedLatest();
testLegacyLatestSelectionUsesMetadataRevision();
testLegacyLatestSelectionFallsBackToHighestRevision();
testMetadataWriteOptionsHandleMissingETag();
testMetadataVerificationRequiresExactPointer();
testBookmarkEventGateDefersPostApplyEvents();

console.log("sync scenarios passed");
