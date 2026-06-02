import type { AppConfig, SyncFile, SyncLogEntry, SyncStatus } from "../../types/bookmark";
import { nowIso } from "../../utils/time";
import { createUuid } from "../../utils/uuid";

const CONFIG_KEY = "s3marks.config";
const DEVICE_ID_KEY = "s3marks.deviceId";
const LAST_SYNC_STATE_KEY = "s3marks.lastSyncState";
const SYNC_STATUS_KEY = "s3marks.syncStatus";
const SYNC_LOGS_KEY = "s3marks.syncLogs";
const MAX_LOG_ENTRIES = 100;

const memoryStore = new Map<string, unknown>();

export const DEFAULT_AUTO_SYNC_INTERVAL = 60;

export function getEmptyConfig(): AppConfig {
  return {
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "s3marks",
    forcePathStyle: true,
    encryptionPassword: "",
    autoSyncIntervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL,
    syncOnBookmarkChange: true,
    syncOnBrowserStartup: true,
    syncAfterConfigSave: true
  };
}

export async function getConfig(): Promise<AppConfig | null> {
  const config = await storageGet<AppConfig>(CONFIG_KEY);
  return config ? { ...getEmptyConfig(), ...config } : null;
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await storageSet(CONFIG_KEY, normalizeConfig(config));
}

export async function getDeviceId(): Promise<string> {
  const existing = await storageGet<string>(DEVICE_ID_KEY);

  if (existing) {
    return existing;
  }

  const deviceId = createUuid();
  await storageSet(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export async function getLastSyncState(): Promise<SyncFile | null> {
  return (await storageGet<SyncFile>(LAST_SYNC_STATE_KEY)) ?? null;
}

export async function saveLastSyncState(state: SyncFile): Promise<void> {
  await storageSet(LAST_SYNC_STATE_KEY, state);
}

export async function clearLastSyncState(): Promise<void> {
  await storageRemove(LAST_SYNC_STATE_KEY);
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return (
    (await storageGet<SyncStatus>(SYNC_STATUS_KEY)) ?? {
      level: "idle",
      message: "尚未同步"
    }
  );
}

export async function saveSyncStatus(status: SyncStatus): Promise<void> {
  await storageSet(SYNC_STATUS_KEY, status);
}

export async function getSyncLogs(): Promise<SyncLogEntry[]> {
  return (await storageGet<SyncLogEntry[]>(SYNC_LOGS_KEY)) ?? [];
}

export async function appendSyncLog(level: SyncLogEntry["level"], message: string): Promise<void> {
  const logs = await getSyncLogs();
  const nextLogs = [
    {
      id: createUuid(),
      createdAt: nowIso(),
      level,
      message
    },
    ...logs
  ].slice(0, MAX_LOG_ENTRIES);

  await storageSet(SYNC_LOGS_KEY, nextLogs);
}

export async function clearSyncLogs(): Promise<void> {
  await storageRemove(SYNC_LOGS_KEY);
}

export function isConfigComplete(config: AppConfig | null): config is AppConfig {
  return Boolean(
    config?.endpoint
      && config.region
      && config.bucket
      && config.accessKeyId
      && config.secretAccessKey
  );
}

function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...getEmptyConfig(),
    ...config,
    endpoint: config.endpoint.trim(),
    region: config.region.trim() || "auto",
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey,
    prefix: config.prefix.trim().replace(/^\/+|\/+$/g, ""),
    forcePathStyle: Boolean(config.forcePathStyle),
    encryptionPassword: config.encryptionPassword ?? "",
    autoSyncIntervalMinutes: Number(config.autoSyncIntervalMinutes ?? DEFAULT_AUTO_SYNC_INTERVAL),
    syncOnBookmarkChange: config.syncOnBookmarkChange ?? true,
    syncOnBrowserStartup: config.syncOnBrowserStartup ?? true,
    syncAfterConfigSave: config.syncAfterConfigSave ?? true
  };
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  const browserStorage = getBrowserStorage();

  if (browserStorage) {
    const result = await browserStorage.get(key);
    return result[key] as T | undefined;
  }

  if (globalThis.chrome?.storage?.local) {
    return new Promise<T | undefined>((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const runtimeError = chrome.runtime?.lastError;

        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(result[key] as T | undefined);
      });
    });
  }

  if (globalThis.localStorage) {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  return memoryStore.get(key) as T | undefined;
}

async function storageSet<T>(key: string, value: T): Promise<void> {
  const browserStorage = getBrowserStorage();

  if (browserStorage) {
    await browserStorage.set({ [key]: value });
    return;
  }

  if (globalThis.chrome?.storage?.local) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const runtimeError = chrome.runtime?.lastError;

        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    });
    return;
  }

  if (globalThis.localStorage) {
    localStorage.setItem(key, JSON.stringify(value));
    return;
  }

  memoryStore.set(key, value);
}

async function storageRemove(key: string): Promise<void> {
  const browserStorage = getBrowserStorage();

  if (browserStorage) {
    await browserStorage.remove(key);
    return;
  }

  if (globalThis.chrome?.storage?.local) {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.local.remove(key, () => {
        const runtimeError = chrome.runtime?.lastError;

        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    });
    return;
  }

  if (globalThis.localStorage) {
    localStorage.removeItem(key);
    return;
  }

  memoryStore.delete(key);
}

function getBrowserStorage():
  | {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    }
  | null {
  const browserStorage = (globalThis as {
    browser?: {
      storage?: {
        local?: {
          get: (key: string) => Promise<Record<string, unknown>>;
          set: (items: Record<string, unknown>) => Promise<void>;
          remove: (key: string) => Promise<void>;
        };
      };
    };
  }).browser?.storage?.local;

  return browserStorage ?? null;
}
