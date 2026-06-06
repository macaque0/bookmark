import {
  appendPendingBookmarkDeletions,
  appendSyncLog,
  clearLastSyncState,
  getConfig,
  getSyncStatus,
  isConfigComplete
} from "../core/config/configStore";
import { testS3Connection } from "../core/storage/s3Storage";
import { downloadOnly, getRemoteBookmarkCount, syncNow, uploadOnly } from "../core/sync/syncEngine";
import type { PendingBookmarkDeletion } from "../types/bookmark";
import {
  getBookmarkEventDecision,
  getDeferredBookmarkChangeDelayMinutes,
  type BookmarkEventDecision
} from "./eventGate";
import { createFolderDeletionFingerprint } from "../core/sync/deletions";

const AUTO_SYNC_ALARM = "s3marks.autoSync";
const BOOKMARK_CHANGE_ALARM = "s3marks.bookmarkChangeAutoSync";
const STARTUP_SYNC_ALARM = "s3marks.startupAutoSync";
const BOOKMARK_CHANGE_DEBOUNCE_MINUTES = 0.25;
const STARTUP_SYNC_DELAY_MINUTES = 0.17;
const POST_SYNC_EVENT_SUPPRESSION_MS = 10_000;

let syncInFlight: Promise<void> | null = null;
let queuedSyncReason: string | null = null;
let applyingSyncedBookmarks = false;
let suppressBookmarkEventsUntil = 0;

type BookmarkChangeHandlingResult =
  | "ignored"
  | "queued"
  | "scheduled"
  | "deferred"
  | "disabled";

type BackgroundMessage =
  | { type: "uploadOnly" }
  | { type: "downloadOnly" }
  | { type: "syncNow" }
  | { type: "getStatus" }
  | { type: "getRemoteBookmarkCount" }
  | { type: "testConnection" }
  | { type: "clearState" }
  | { type: "rescheduleAutoSync" };

chrome.runtime.onInstalled.addListener(() => {
  void scheduleAutoSync();
});

chrome.runtime.onStartup.addListener(() => {
  void handleBrowserStartup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    runSyncInBackground("定时兜底同步");
  }

  if (alarm.name === BOOKMARK_CHANGE_ALARM) {
    runSyncInBackground("书签变化自动同步");
  }

  if (alarm.name === STARTUP_SYNC_ALARM) {
    runSyncInBackground("浏览器启动同步");
  }
});

chrome.bookmarks.onCreated.addListener((_id, node) => {
  void handleBookmarkCreated(node);
});

chrome.bookmarks.onRemoved.addListener((_id, removeInfo) => {
  void handleBookmarkRemoved(removeInfo.node);
});

chrome.bookmarks.onChanged.addListener((_id, changeInfo) => {
  void handleLoggedBookmarkChange(
    `检测到书签或文件夹修改：${formatBookmarkTitle(changeInfo.title)}。`
  );
});

chrome.bookmarks.onMoved.addListener(() => {
  void handleLoggedBookmarkChange("检测到书签或文件夹移动。");
});

chrome.bookmarks.onChildrenReordered.addListener((_id, reorderInfo) => {
  void handleLoggedBookmarkChange(
    `检测到书签顺序调整，共 ${reorderInfo.childIds.length} 项。`
  );
});

chrome.bookmarks.onImportEnded.addListener(() => {
  void handleLoggedBookmarkChange("检测到书签导入完成。");
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "后台任务失败"
      });
    });

  return true;
});

async function handleMessage(message: BackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case "uploadOnly":
      await uploadOnly();
      return getSyncStatus();
    case "downloadOnly":
      await downloadOnly(createApplyHooks());
      return getSyncStatus();
    case "syncNow":
      await runSyncWithLock("手动同步");
      return getSyncStatus();
    case "getStatus":
      return getSyncStatus();
    case "getRemoteBookmarkCount":
      return getRemoteBookmarkCount();
    case "testConnection":
      await testS3Connection();
      return null;
    case "clearState":
      await clearLastSyncState();
      return getSyncStatus();
    case "rescheduleAutoSync":
      await scheduleAutoSync();
      await scheduleSyncAfterConfigSave();
      return getSyncStatus();
    default:
      throw new Error("未知后台消息。");
  }
}

async function scheduleAutoSync(): Promise<void> {
  await clearAlarm(AUTO_SYNC_ALARM);
  const config = await getConfig();
  const interval = Number(config?.autoSyncIntervalMinutes ?? 0);

  if (isConfigComplete(config) && interval > 0) {
    chrome.alarms.create(AUTO_SYNC_ALARM, {
      delayInMinutes: interval,
      periodInMinutes: interval
    });
  }
}

async function handleBrowserStartup(): Promise<void> {
  await scheduleAutoSync();
  await scheduleStartupSync();
}

async function scheduleStartupSync(): Promise<void> {
  await clearAlarm(STARTUP_SYNC_ALARM);
  const config = await getConfig();

  if (isConfigComplete(config) && config.syncOnBrowserStartup !== false) {
    chrome.alarms.create(STARTUP_SYNC_ALARM, {
      delayInMinutes: STARTUP_SYNC_DELAY_MINUTES
    });
  }
}

async function handleBookmarkChangeDecision(
  decision: BookmarkEventDecision
): Promise<BookmarkChangeHandlingResult> {
  if (decision === "ignore") {
    return "ignored";
  }

  if (syncInFlight) {
    queuedSyncReason = "书签变化自动同步";
    return "queued";
  }

  const scheduled = await scheduleBookmarkChangeSync(
    decision === "defer"
      ? getDeferredBookmarkChangeDelayMinutes(
          suppressBookmarkEventsUntil,
          BOOKMARK_CHANGE_DEBOUNCE_MINUTES
        )
      : BOOKMARK_CHANGE_DEBOUNCE_MINUTES
  );

  if (!scheduled) {
    return "disabled";
  }

  return decision === "defer" ? "deferred" : "scheduled";
}

async function handleBookmarkCreated(node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
  const itemType = node.url ? "书签" : "文件夹";
  await handleLoggedBookmarkChange(
    `检测到新增${itemType}：${formatBookmarkTitle(node.title)}。`
  );
}

async function handleBookmarkRemoved(node: chrome.bookmarks.BookmarkTreeNode): Promise<void> {
  const decision = getCurrentBookmarkEventDecision();

  if (decision === "ignore") {
    return;
  }

  if (decision === "handle") {
    const deletions = createDeletionEntries(node);
    await appendPendingBookmarkDeletions(deletions);
    const result = await handleBookmarkChangeDecision(decision);
    await appendSyncLog(
      "info",
      [
        `检测到删除${node.url ? "书签" : "文件夹"}：${formatBookmarkTitle(node.title)}`,
        `已记录 ${deletions.length} 个待同步删除项`,
        formatBookmarkChangeOutcome(result)
      ].join("，")
    );
    return;
  }

  await handleLoggedBookmarkChange(
    `检测到删除事件：${formatBookmarkTitle(node.title)}。`,
    decision
  );
}

async function handleLoggedBookmarkChange(
  eventMessage: string,
  decision = getCurrentBookmarkEventDecision()
): Promise<void> {
  const result = await handleBookmarkChangeDecision(decision);

  if (result === "ignored") {
    return;
  }

  await appendSyncLog("info", `${eventMessage}${formatBookmarkChangeOutcome(result)}`);
}

async function scheduleBookmarkChangeSync(delayInMinutes: number): Promise<boolean> {
  const config = await getConfig();

  if (!isConfigComplete(config) || config.syncOnBookmarkChange === false) {
    return false;
  }

  await clearAlarm(BOOKMARK_CHANGE_ALARM);
  chrome.alarms.create(BOOKMARK_CHANGE_ALARM, {
    delayInMinutes
  });
  return true;
}

async function scheduleSyncAfterConfigSave(): Promise<void> {
  const config = await getConfig();

  if (isConfigComplete(config) && config.syncAfterConfigSave !== false) {
    runSyncInBackground("配置保存后首次同步");
  }
}

function runSyncInBackground(reason: string): void {
  void runSyncWithLock(reason).catch(() => undefined);
}

async function runSyncWithLock(reason: string): Promise<void> {
  if (syncInFlight) {
    queuedSyncReason = reason;
    await syncInFlight;
    return;
  }

  syncInFlight = runSyncLoop(reason);

  try {
    await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function runSyncLoop(initialReason: string): Promise<void> {
  let reason: string | null = initialReason;

  while (reason) {
    queuedSyncReason = null;
    await clearAlarm(BOOKMARK_CHANGE_ALARM);
    await syncNow(createApplyHooks());
    reason = queuedSyncReason;
  }
}

function createApplyHooks() {
  return {
    beforeApply() {
      applyingSyncedBookmarks = true;
      suppressBookmarkEventsUntil = Date.now() + POST_SYNC_EVENT_SUPPRESSION_MS;
    },
    afterApply() {
      applyingSyncedBookmarks = false;
      suppressBookmarkEventsUntil = Date.now() + POST_SYNC_EVENT_SUPPRESSION_MS;
    }
  };
}

function getCurrentBookmarkEventDecision(): BookmarkEventDecision {
  return getBookmarkEventDecision({
    applyingSyncedBookmarks,
    suppressBookmarkEventsUntil
  });
}

function formatBookmarkChangeOutcome(result: BookmarkChangeHandlingResult): string {
  switch (result) {
    case "queued":
      return "当前同步进行中，已加入下一轮同步。";
    case "scheduled":
      return "已安排自动同步。";
    case "deferred":
      return "处于同步写回保护期，已延后自动同步。";
    case "disabled":
      return "书签变化自动同步未启用或配置不完整。";
    default:
      return "";
  }
}

function formatBookmarkTitle(title: string): string {
  const normalized = title.trim() || "未命名";
  const displayTitle = normalized.length > 60
    ? `${normalized.slice(0, 60)}...`
    : normalized;

  return `“${displayTitle}”`;
}

function createDeletionEntries(
  node: chrome.bookmarks.BookmarkTreeNode
): Array<Omit<PendingBookmarkDeletion, "id" | "createdAt">> {
  const self: Omit<PendingBookmarkDeletion, "id" | "createdAt"> = node.url
    ? {
        type: "bookmark",
        title: node.title,
        url: node.url
      }
    : {
        type: "folder",
        title: node.title,
        folderFingerprint: createFolderDeletionFingerprint(node)
      };

  return [
    self,
    ...(node.children ?? []).flatMap((child) => createDeletionEntries(child))
  ];
}

async function clearAlarm(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.alarms.clear(name, () => resolve());
  });
}
