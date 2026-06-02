import assert from "node:assert/strict";
import type { NormalizedBookmarkNode } from "../src/types/bookmark";
import { prepareBrowserRootUpdates } from "../src/core/bookmarks/applyBookmarkTree";
import { normalizeBookmarkTree } from "../src/core/bookmarks/normalizeBookmarks";
import { mergeBookmarkTrees } from "../src/core/sync/merge";
import { normalizeSyncTree } from "../src/core/sync/tree";

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

async function testManagedRootDoesNotDisappear() {
  const remote = normalizeSyncTree(
    normalizeBookmarkTree(
      browserTree([
        folder("收藏夹栏", [bookmark("Edge A", "https://edge.example", 0)], 0)
      ])
    )
  );
  const chromeOutside = normalizeBookmarkTree(
    browserTree([
      folder("其他收藏夹", [bookmark("Chrome B", "https://chrome.example", 0)], 0),
      folder(
        "S3Marks",
        [
          folder("Bookmarks Bar", [bookmark("Edge A", "https://edge.example", 0)], 0)
        ],
        1
      )
    ]),
    { excludeRootTitles: ["S3Marks"] }
  );
  const chromeManaged = normalizeBookmarkTree(
    browserTree([
      folder("Bookmarks Bar", [bookmark("Edge A", "https://edge.example", 0)], 0)
    ])
  );
  const localCombined = normalizeSyncTree(
    (await mergeBookmarkTrees([], chromeOutside, chromeManaged)).tree
  );
  const merged = await mergeBookmarkTrees(remote, localCombined, remote);
  const mergedTitles = titles(merged.tree);

  assert.equal(merged.conflicts.length, 0);
  assert.ok(mergedTitles.includes("/Bookmarks Bar/Edge A"));
  assert.ok(mergedTitles.includes("/Other Bookmarks/Chrome B"));
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

function testManagedRootContentIsMigrated() {
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

  assert.ok(allTitles.includes("/Bookmarks Bar/Remote A"));
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
        folder("Sync Conflicts", [bookmark("Conflict A", "https://conflict.example", 0)], 1)
      ])
    )
  );
  const updates = prepareBrowserRootUpdates(tree, rootMap);

  assert.equal(updates.has("S3Marks"), false);
  assert.ok(updates.get("Bookmarks Bar")?.some((node) => node.title === "A"));
  assert.ok(updates.get("Other Bookmarks")?.some((node) => node.title === "Sync Conflicts"));
}

await testManagedRootDoesNotDisappear();
await testStaleChineseBaseDoesNotDeleteRemote();
testRootTitleCanonicalization();
testManagedRootContentIsMigrated();
testNativeRootUpdatePlanDoesNotCreateManagedRoot();

console.log("sync scenarios passed");
