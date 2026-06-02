import type {
  AppConfig,
  EncryptedPayload,
  NormalizedBookmarkNode,
  SyncFile,
  SyncMetadata,
  SyncStatus
} from "../../types/bookmark";
import { applyBookmarkTree, findManagedRoots, MANAGED_ROOT_TITLE } from "../bookmarks/applyBookmarkTree";
import { getBrowserBookmarkTree } from "../bookmarks/browserBookmarks";
import { countBookmarks, normalizeBookmarkTree, sortTreeByIndex } from "../bookmarks/normalizeBookmarks";
import {
  appendSyncLog,
  getConfig,
  getDeviceId,
  getLastSyncState,
  getSyncStatus,
  isConfigComplete,
  saveLastSyncState,
  saveSyncStatus
} from "../config/configStore";
import { decryptJson, encryptJson } from "../crypto/encrypt";
import { getObjectText, putObjectText } from "../storage/s3Storage";
import { formatRevisionFileName, nowIso } from "../../utils/time";
import { mergeBookmarkTrees } from "./merge";
import { normalizeSyncTree } from "./tree";

const LATEST_JSON_KEY = "latest.json";
const LATEST_ENCRYPTED_KEY = "latest.json.enc";
const METADATA_KEY = "metadata.json";

export async function uploadOnly(): Promise<void> {
  await runSyncOperation("上传本地书签到 S3", async () => {
    const config = await requireAppConfig();
    const localTree = await readLocalNormalizedTree();
    const remoteMetadata = await downloadMetadata();
    const revision = Math.max(remoteMetadata?.latestRevision ?? 0, 0) + 1;
    const syncFile = await createSyncFile(localTree, revision);

    await uploadSyncFile(syncFile, config);
    await saveLastSyncState(syncFile);

    return {
      message: "上传完成",
      bookmarkCount: countBookmarks(localTree),
      remoteBookmarkCount: countBookmarks(localTree),
      conflictCount: 0
    };
  });
}

export async function downloadOnly(): Promise<void> {
  await runSyncOperation("从 S3 下载书签", async () => {
    const config = await requireAppConfig();
    const remote = await downloadLatestSyncFile(config);

    if (!remote) {
      throw new Error("S3 中尚未找到 latest.json。");
    }

    await applyBookmarkTree(remote.tree);
    await saveLastSyncState(remote);

    return {
      message: "下载并导入完成",
      bookmarkCount: countBookmarks(remote.tree),
      remoteBookmarkCount: countBookmarks(remote.tree),
      conflictCount: 0
    };
  });
}

export async function syncNow(): Promise<void> {
  await runSyncOperation("执行双向同步", async () => {
    const config = await requireAppConfig();
    const remote = await downloadLatestSyncFile(config);
    const baseState = await getLastSyncState();

    if (!remote) {
      const localTree = await readLocalNormalizedTree();
      const firstRevision = await createSyncFile(localTree, 1);
      await uploadSyncFile(firstRevision, config);
      await saveLastSyncState(firstRevision);

      return {
        message: "远程为空，已上传本地书签",
        bookmarkCount: countBookmarks(localTree),
        remoteBookmarkCount: countBookmarks(localTree),
        conflictCount: 0
      };
    }

    if (!baseState) {
      const localTree = await readLocalNormalizedTree();
      const mergeResult = await mergeBookmarkTrees([], localTree, remote.tree);
      const nextRevision = await createSyncFile(mergeResult.tree, remote.revision + 1);

      await applyBookmarkTree(mergeResult.tree);
      await uploadSyncFile(nextRevision, config);
      await saveLastSyncState(nextRevision);

      return {
        message:
          mergeResult.conflicts.length > 0
            ? `首次同步完成，已合并本地和 S3 书签，发现 ${mergeResult.conflicts.length} 个冲突`
            : "首次同步完成，已合并本地和 S3 书签",
        bookmarkCount: countBookmarks(mergeResult.tree),
        remoteBookmarkCount: countBookmarks(mergeResult.tree),
        conflictCount: mergeResult.conflicts.length
      };
    }

    const localTree = await readLocalNormalizedTree();
    const base = normalizeSyncTree(baseState.tree, MANAGED_ROOT_TITLE);
    const mergeResult = await mergeBookmarkTrees(base, localTree, remote.tree);
    const nextRevision = await createSyncFile(mergeResult.tree, remote.revision + 1);

    await applyBookmarkTree(mergeResult.tree);
    await uploadSyncFile(nextRevision, config);
    await saveLastSyncState(nextRevision);

    return {
      message:
        mergeResult.conflicts.length > 0
          ? `同步完成，发现 ${mergeResult.conflicts.length} 个冲突`
          : "同步完成",
      bookmarkCount: countBookmarks(mergeResult.tree),
      remoteBookmarkCount: countBookmarks(mergeResult.tree),
      conflictCount: mergeResult.conflicts.length
    };
  });
}

export async function getRemoteBookmarkCount(): Promise<number | null> {
  const config = await requireAppConfig();
  const remote = await downloadLatestSyncFile(config);
  return remote ? countBookmarks(remote.tree) : null;
}

export async function readLocalNormalizedTree(): Promise<NormalizedBookmarkNode[]> {
  const rawTree = await getBrowserBookmarkTree();
  const browserTree = sortTreeByIndex(
    normalizeBookmarkTree(rawTree, {
      excludeRootTitles: [MANAGED_ROOT_TITLE]
    })
  );
  const managedRoots = await findManagedRoots();

  if (managedRoots.length === 0) {
    return normalizeSyncTree(browserTree, MANAGED_ROOT_TITLE);
  }

  const managedTree = sortTreeByIndex(
    normalizeBookmarkTree([
      {
        id: "0",
        title: "",
        children: managedRoots.flatMap((root) => root.children ?? [])
      }
    ])
  );
  const combined = await mergeBookmarkTrees([], browserTree, managedTree);

  return normalizeSyncTree(combined.tree, MANAGED_ROOT_TITLE);
}

export async function downloadLatestSyncFile(config: AppConfig): Promise<SyncFile | null> {
  const encryptedText = await getObjectText(LATEST_ENCRYPTED_KEY);

  if (encryptedText) {
    if (!isEncryptionEnabled(config)) {
      throw new Error("远程 latest.json 已加密，请先在设置页填写加密密码。");
    }

    return sanitizeSyncFile(
      await decryptJson<SyncFile>(
        JSON.parse(encryptedText) as EncryptedPayload,
        config.encryptionPassword ?? ""
      )
    );
  }

  const plaintext = await getObjectText(LATEST_JSON_KEY);

  if (!plaintext) {
    return null;
  }

  return sanitizeSyncFile(JSON.parse(plaintext) as SyncFile);
}

async function uploadSyncFile(syncFile: SyncFile, config: AppConfig): Promise<void> {
  const encrypted = isEncryptionEnabled(config);
  const body = encrypted
    ? JSON.stringify(await encryptJson(syncFile, config.encryptionPassword ?? ""), null, 2)
    : JSON.stringify(syncFile, null, 2);
  const latestKey = encrypted ? LATEST_ENCRYPTED_KEY : LATEST_JSON_KEY;
  const metadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: syncFile.revision,
    latestUpdatedAt: syncFile.updatedAt,
    latestDeviceId: syncFile.deviceId
  };

  await putObjectText(latestKey, body);
  await putObjectText(formatRevisionFileName(syncFile.revision, encrypted), body);
  await putObjectText(METADATA_KEY, JSON.stringify(metadata, null, 2));
}

async function downloadMetadata(): Promise<SyncMetadata | null> {
  const text = await getObjectText(METADATA_KEY);
  return text ? (JSON.parse(text) as SyncMetadata) : null;
}

async function createSyncFile(
  tree: NormalizedBookmarkNode[],
  revision: number
): Promise<SyncFile> {
  return {
    schemaVersion: 1,
    revision,
    deviceId: await getDeviceId(),
    updatedAt: nowIso(),
    tree: normalizeSyncTree(tree, MANAGED_ROOT_TITLE)
  };
}

function sanitizeSyncFile(syncFile: SyncFile): SyncFile {
  return {
    ...syncFile,
    tree: normalizeSyncTree(syncFile.tree, MANAGED_ROOT_TITLE)
  };
}

async function requireAppConfig(): Promise<AppConfig> {
  const config = await getConfig();

  if (!isConfigComplete(config)) {
    throw new Error("请先在设置页完整填写 S3 配置。");
  }

  return config;
}

function isEncryptionEnabled(config: AppConfig): boolean {
  return Boolean(config.encryptionPassword?.trim());
}

async function runSyncOperation(
  label: string,
  operation: () => Promise<{
    message: string;
    bookmarkCount?: number;
    remoteBookmarkCount?: number;
    conflictCount?: number;
  }>
): Promise<void> {
  await saveSyncStatus({
    level: "running",
    message: `${label}中...`
  });

  try {
    const result = await operation();
    const status: SyncStatus = {
      level: "success",
      message: result.message,
      lastSyncAt: nowIso(),
      bookmarkCount: result.bookmarkCount,
      remoteBookmarkCount: result.remoteBookmarkCount,
      conflictCount: result.conflictCount
    };

    await saveSyncStatus(status);
    await appendSyncLog("info", result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${label}失败`;
    const previous = await getSyncStatus();

    await saveSyncStatus({
      ...previous,
      level: "error",
      message,
      lastError: message
    });
    await appendSyncLog("error", message);
    throw error;
  }
}
