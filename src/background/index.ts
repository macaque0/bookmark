import {
  clearLastSyncState,
  getConfig,
  getSyncStatus,
  isConfigComplete
} from "../core/config/configStore";
import { testS3Connection } from "../core/storage/s3Storage";
import { downloadOnly, getRemoteBookmarkCount, syncNow, uploadOnly } from "../core/sync/syncEngine";

const AUTO_SYNC_ALARM = "s3marks.autoSync";
const BOOKMARK_CHANGE_ALARM = "s3marks.bookmarkChangeAutoSync";
const STARTUP_SYNC_ALARM = "s3marks.startupAutoSync";
const BOOKMARK_CHANGE_DEBOUNCE_MINUTES = 0.25;
const STARTUP_SYNC_DELAY_MINUTES = 0.17;
const POST_SYNC_EVENT_SUPPRESSION_MS = 10_000;

let syncInFlight: Promise<void> | null = null;
let queuedSyncReason: string | null = null;
let suppressBookmarkEventsUntil = 0;

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

chrome.bookmarks.onCreated.addListener(() => {
  void scheduleBookmarkChangeSync();
});

chrome.bookmarks.onRemoved.addListener(() => {
  void scheduleBookmarkChangeSync();
});

chrome.bookmarks.onChanged.addListener(() => {
  void scheduleBookmarkChangeSync();
});

chrome.bookmarks.onMoved.addListener(() => {
  void scheduleBookmarkChangeSync();
});

chrome.bookmarks.onChildrenReordered.addListener(() => {
  void scheduleBookmarkChangeSync();
});

chrome.bookmarks.onImportEnded.addListener(() => {
  void scheduleBookmarkChangeSync();
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
      await downloadOnly();
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

async function scheduleBookmarkChangeSync(): Promise<void> {
  if (Date.now() < suppressBookmarkEventsUntil || syncInFlight) {
    return;
  }

  const config = await getConfig();

  if (!isConfigComplete(config) || config.syncOnBookmarkChange === false) {
    return;
  }

  await clearAlarm(BOOKMARK_CHANGE_ALARM);
  chrome.alarms.create(BOOKMARK_CHANGE_ALARM, {
    delayInMinutes: BOOKMARK_CHANGE_DEBOUNCE_MINUTES
  });
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
    suppressBookmarkEventsUntil = Date.now() + POST_SYNC_EVENT_SUPPRESSION_MS;
    await clearAlarm(BOOKMARK_CHANGE_ALARM);
    await syncNow();
    suppressBookmarkEventsUntil = Date.now() + POST_SYNC_EVENT_SUPPRESSION_MS;
    reason = queuedSyncReason;
  }
}

async function clearAlarm(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.alarms.clear(name, () => resolve());
  });
}
