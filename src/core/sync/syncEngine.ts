import type {
  AppConfig,
  EncryptedPayload,
  NormalizedBookmarkNode,
  SyncFile,
  SyncMetadata,
  SyncStatus
} from "../../types/bookmark";
import { applyBookmarkTree } from "../bookmarks/applyBookmarkTree";
import { getBrowserBookmarkTree } from "../bookmarks/browserBookmarks";
import { countBookmarks, normalizeBookmarkTree, sortTreeByIndex } from "../bookmarks/normalizeBookmarks";
import {
  appendSyncLog,
  clearPendingBookmarkDeletions,
  getConfig,
  getDeviceId,
  getLastSyncState,
  getPendingBookmarkDeletions,
  getSyncStatus,
  isConfigComplete,
  saveLastSyncState,
  saveSyncStatus
} from "../config/configStore";
import { decryptJson, encryptJson } from "../crypto/encrypt";
import {
  ConditionalWriteError,
  deleteObjectIfExists,
  getObjectText,
  getObjectTextWithETag,
  MUTABLE_OBJECT_CACHE_CONTROL,
  putObjectText
} from "../storage/s3Storage";
import { formatRevisionFileName, nowIso } from "../../utils/time";
import { nodeSignature } from "./diff";
import {
  applyPendingBookmarkDeletions,
  filterPendingDeletionsMissingFromTree,
  type PendingDeletionOptions
} from "./deletions";
import {
  chooseLegacyLatestSyncFile,
  getMetadataWriteOptions,
  getMetadataLatestKey,
  getStaleLatestKey,
  isEncryptedLatestKey,
  isSameSyncMetadata,
  LATEST_ENCRYPTED_KEY,
  LATEST_JSON_KEY,
  METADATA_KEY,
  shouldUsePlaintextBeforeEncrypted
} from "./latestObject";
import { mergeBookmarkTrees } from "./merge";
import { normalizeSyncTree } from "./tree";

export interface SyncApplyHooks {
  beforeApply?: () => void | Promise<void>;
  afterApply?: () => void | Promise<void>;
}

interface MetadataState {
  metadata: SyncMetadata | null;
  eTag: string | null;
}

interface LatestSyncState {
  syncFile: SyncFile | null;
  metadataState: MetadataState;
}

const METADATA_VERIFY_DELAYS_MS = [0, 150, 300, 600, 1_200];

export async function uploadOnly(): Promise<void> {
  await runSyncOperation("上传本地书签到 S3", async () => {
    const config = await requireAppConfig();
    const localTree = await readLocalNormalizedTree();
    const metadataState = await downloadMetadataState();
    const revision = Math.max(metadataState.metadata?.latestRevision ?? 0, 0) + 1;
    const syncFile = await createSyncFile(localTree, revision);

    await uploadSyncFile(syncFile, config, metadataState);
    await saveLastSyncState(syncFile);
    await clearPendingBookmarkDeletions();

    return {
      message: "上传完成",
      bookmarkCount: countBookmarks(localTree),
      remoteBookmarkCount: countBookmarks(localTree),
      conflictCount: 0
    };
  });
}

export async function downloadOnly(hooks: SyncApplyHooks = {}): Promise<void> {
  await runSyncOperation("从 S3 下载书签", async () => {
    const config = await requireAppConfig();
    const remote = await downloadLatestSyncFile(config);

    if (!remote) {
      throw new Error("S3 中尚未找到最新同步文件。");
    }

    await applyBookmarkTreeWithHooks(remote.tree, hooks);
    await saveLastSyncState(remote);
    await clearPendingBookmarkDeletions();

    return {
      message: "下载并导入完成",
      bookmarkCount: countBookmarks(remote.tree),
      remoteBookmarkCount: countBookmarks(remote.tree),
      conflictCount: 0
    };
  });
}

export async function syncNow(hooks: SyncApplyHooks = {}): Promise<void> {
  await runSyncOperation("执行双向同步", async () => {
    const config = await requireAppConfig();
    const remoteState = await downloadLatestSyncState(config);
    const remote = remoteState.syncFile;
    const baseState = await getLastSyncState();
    const pendingDeletions = await getPendingBookmarkDeletions();

    if (!remote) {
      const localTree = await readLocalNormalizedTree();
      const firstRevision = await createSyncFile(localTree, 1);
      await uploadSyncFile(firstRevision, config, remoteState.metadataState);
      await saveLastSyncState(firstRevision);
      await clearPendingBookmarkDeletions();

      return {
        message: "远程为空，已上传本地书签",
        bookmarkCount: countBookmarks(localTree),
        remoteBookmarkCount: countBookmarks(localTree),
        conflictCount: 0
      };
    }

    if (!baseState) {
      const { localTree, mergeResult } = await mergeWithStableLocal(
        [],
        remote.tree,
        pendingDeletions,
        { includeFolders: true }
      );
      const shouldUpload = shouldUploadMergedTree(remote.tree, mergeResult.tree);
      const nextState = shouldUpload
        ? await createSyncFile(mergeResult.tree, remote.revision + 1)
        : { ...remote, tree: normalizeSyncTree(mergeResult.tree) };

      await appendSyncDecisionLog(baseState, localTree, remote, mergeResult.tree, shouldUpload);

      if (shouldUpload) {
        await uploadSyncFile(nextState, config, remoteState.metadataState);
      }

      await applyBookmarkTreeIfChanged(localTree, mergeResult.tree, hooks);
      await saveLastSyncState(nextState);
      await clearPendingBookmarkDeletions();

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

    const base = normalizeSyncTree(baseState.tree);
    const { localTree, mergeResult } = await mergeWithStableLocal(
      base,
      remote.tree,
      pendingDeletions,
      { includeFolders: false }
    );
    const shouldUpload = shouldUploadMergedTree(remote.tree, mergeResult.tree);
    const nextState = shouldUpload
      ? await createSyncFile(mergeResult.tree, remote.revision + 1)
      : { ...remote, tree: normalizeSyncTree(mergeResult.tree) };

    await appendSyncDecisionLog(baseState, localTree, remote, mergeResult.tree, shouldUpload);

    if (shouldUpload) {
      await uploadSyncFile(nextState, config, remoteState.metadataState);
    }

    await applyBookmarkTreeIfChanged(localTree, mergeResult.tree, hooks);
    await saveLastSyncState(nextState);
    await clearPendingBookmarkDeletions();

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

async function mergeWithStableLocal(
  base: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[],
  pendingDeletions: Awaited<ReturnType<typeof getPendingBookmarkDeletions>> = [],
  pendingDeletionOptions: PendingDeletionOptions = {}
): Promise<{
  localTree: NormalizedBookmarkNode[];
  mergeResult: Awaited<ReturnType<typeof mergeBookmarkTrees>>;
}> {
  let localTree = await readLocalNormalizedTree();
  let mergeResult = await mergeBookmarkTrees(
    base,
    localTree,
    applyDeletionsForLocalTree(remote, pendingDeletions, localTree, pendingDeletionOptions)
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const freshLocalTree = await readLocalNormalizedTree();

    if (treeSignature(freshLocalTree) === treeSignature(localTree)) {
      return { localTree, mergeResult };
    }

    localTree = freshLocalTree;
    mergeResult = await mergeBookmarkTrees(
      base,
      localTree,
      applyDeletionsForLocalTree(remote, pendingDeletions, localTree, pendingDeletionOptions)
    );
  }

  await appendSyncLog(
    "info",
    "同步期间检测到本地书签仍在变化，本次已使用最后一次读取到的本地书签重新合并。"
  );

  return { localTree, mergeResult };
}

function shouldUploadMergedTree(
  remoteTree: NormalizedBookmarkNode[],
  mergedTree: NormalizedBookmarkNode[]
): boolean {
  return treeSignature(normalizeSyncTree(remoteTree)) !== treeSignature(normalizeSyncTree(mergedTree));
}

async function appendSyncDecisionLog(
  baseState: SyncFile | null,
  localTree: NormalizedBookmarkNode[],
  remote: SyncFile,
  mergedTree: NormalizedBookmarkNode[],
  shouldUpload: boolean
): Promise<void> {
  await appendSyncLog(
    "info",
    [
      `同步决策：基线 r${baseState?.revision ?? "none"}`,
      `本地 ${countBookmarks(localTree)} 个`,
      `远端 r${remote.revision}/${countBookmarks(remote.tree)} 个`,
      `合并后 ${countBookmarks(mergedTree)} 个`,
      shouldUpload ? "需要上传新版本" : "仅应用远端/无需上传"
    ].join("，")
  );
}

async function applyBookmarkTreeIfChanged(
  localTree: NormalizedBookmarkNode[],
  targetTree: NormalizedBookmarkNode[],
  hooks: SyncApplyHooks
): Promise<void> {
  if (treeSignature(localTree) === treeSignature(normalizeSyncTree(targetTree))) {
    return;
  }

  await applyBookmarkTreeWithHooks(targetTree, hooks);
}

function applyDeletionsForLocalTree(
  remote: NormalizedBookmarkNode[],
  pendingDeletions: Awaited<ReturnType<typeof getPendingBookmarkDeletions>>,
  localTree: NormalizedBookmarkNode[],
  options: PendingDeletionOptions
): NormalizedBookmarkNode[] {
  const activeDeletions = filterPendingDeletionsMissingFromTree(
    pendingDeletions,
    localTree,
    options
  );

  return applyPendingBookmarkDeletions(remote, activeDeletions, options);
}

async function applyBookmarkTreeWithHooks(
  tree: NormalizedBookmarkNode[],
  hooks: SyncApplyHooks
): Promise<void> {
  await hooks.beforeApply?.();

  try {
    await applyBookmarkTree(tree);
  } finally {
    await hooks.afterApply?.();
  }
}

function treeSignature(tree: NormalizedBookmarkNode[]): string {
  return JSON.stringify(tree.map(nodeSignature));
}

export async function getRemoteBookmarkCount(): Promise<number | null> {
  const config = await requireAppConfig();
  const remote = await downloadLatestSyncFile(config);
  return remote ? countBookmarks(remote.tree) : null;
}

export async function readLocalNormalizedTree(): Promise<NormalizedBookmarkNode[]> {
  const rawTree = await getBrowserBookmarkTree();
  const browserTree = sortTreeByIndex(
    normalizeBookmarkTree(rawTree)
  );

  return normalizeSyncTree(browserTree);
}

export async function downloadLatestSyncFile(config: AppConfig): Promise<SyncFile | null> {
  return (await downloadLatestSyncState(config)).syncFile;
}

async function downloadLatestSyncState(config: AppConfig): Promise<LatestSyncState> {
  const metadataState = await downloadMetadataState();
  const metadata = metadataState.metadata;
  const metadataLatestKey = getMetadataLatestKey(metadata);

  if (metadataLatestKey) {
    const text = await getObjectText(metadataLatestKey, {
      bypassCache: isMutableLatestKey(metadataLatestKey)
    });

    if (text) {
      return {
        syncFile: await parseSyncFileText(
          text,
          isEncryptedLatestKey(metadataLatestKey, metadata),
          config,
          metadataLatestKey
        ),
        metadataState
      };
    }
  }

  return {
    syncFile: await downloadLatestSyncFileLegacy(config, metadata),
    metadataState
  };
}

async function downloadLatestSyncFileLegacy(
  config: AppConfig,
  metadata: SyncMetadata | null
): Promise<SyncFile | null> {
  const plaintext = await getObjectText(LATEST_JSON_KEY, { bypassCache: true });
  const plaintextSyncFile = plaintext
    ? sanitizeSyncFile(JSON.parse(plaintext) as SyncFile)
    : null;

  if (shouldUsePlaintextBeforeEncrypted(metadata, plaintextSyncFile)) {
    return plaintextSyncFile;
  }

  const encryptedText = await getObjectText(LATEST_ENCRYPTED_KEY, { bypassCache: true });

  if (!encryptedText) {
    return plaintextSyncFile;
  }

  if (!isEncryptionEnabled(config)) {
    if (plaintextSyncFile && !metadata) {
      return plaintextSyncFile;
    }

    throw new Error("远程最新同步文件可能已加密，请先在设置页填写加密密码。");
  }

  const encryptedSyncFile = await parseSyncFileText(
    encryptedText,
    true,
    config,
    LATEST_ENCRYPTED_KEY
  );
  return chooseLegacyLatestSyncFile(
    metadata,
    [
      plaintextSyncFile ? { key: LATEST_JSON_KEY, syncFile: plaintextSyncFile } : null,
      { key: LATEST_ENCRYPTED_KEY, syncFile: encryptedSyncFile }
    ].filter((candidate): candidate is { key: string; syncFile: SyncFile } => Boolean(candidate))
  );
}

async function uploadSyncFile(
  syncFile: SyncFile,
  config: AppConfig,
  metadataState: MetadataState
): Promise<void> {
  const encrypted = isEncryptionEnabled(config);
  const body = encrypted
    ? JSON.stringify(await encryptJson(syncFile, config.encryptionPassword ?? ""), null, 2)
    : JSON.stringify(syncFile, null, 2);
  const latestKey = encrypted ? LATEST_ENCRYPTED_KEY : LATEST_JSON_KEY;
  const staleLatestKey = getStaleLatestKey(latestKey);
  const revisionKey = formatRevisionFileName(
    syncFile.revision,
    encrypted,
    `${syncFile.deviceId}-${syncFile.updatedAt}`
  );
  const metadata: SyncMetadata = {
    schemaVersion: 1,
    latestRevision: syncFile.revision,
    latestUpdatedAt: syncFile.updatedAt,
    latestDeviceId: syncFile.deviceId,
    latestObjectKey: revisionKey,
    latestEncrypted: encrypted
  };
  const metadataWriteOptions = getMetadataWriteOptions(metadataState);

  try {
    await putObjectText(revisionKey, body, { ifNoneMatch: "*" });

    if (metadataState.metadata && !metadataState.eTag) {
      const latestMetadataState = await downloadMetadataState();

      if (!isSameSyncMetadata(latestMetadataState.metadata, metadataState.metadata)) {
        throw new ConditionalWriteError();
      }

      await appendSyncLog(
        "info",
        "远程 metadata.json 未返回 ETag，本次已在写入前复查 metadata 后继续同步；建议在对象存储 CORS 中暴露 ETag，以恢复强并发保护。"
      );
    }

    await putObjectText(METADATA_KEY, JSON.stringify(metadata, null, 2), {
      ...metadataWriteOptions,
      cacheControl: MUTABLE_OBJECT_CACHE_CONTROL
    });
    await verifyUploadedMetadata(metadata);
  } catch (error) {
    if (error instanceof ConditionalWriteError) {
      throw new Error("远程书签已被其他设备更新，本次同步已取消。请重新点击同步以合并最新远程版本。");
    }

    throw error;
  }

  await putLatestAlias(latestKey, body);
  await deleteStaleLatestObject(staleLatestKey);
}

async function downloadMetadataState(): Promise<MetadataState> {
  const result = await getObjectTextWithETag(METADATA_KEY, { bypassCache: true });

  if (!result) {
    return {
      metadata: null,
      eTag: null
    };
  }

  return {
    metadata: JSON.parse(result.text) as SyncMetadata,
    eTag: result.eTag
  };
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
    tree: normalizeSyncTree(tree)
  };
}

function sanitizeSyncFile(syncFile: SyncFile): SyncFile {
  return {
    ...syncFile,
    tree: normalizeSyncTree(syncFile.tree)
  };
}

async function parseSyncFileText(
  text: string,
  encrypted: boolean,
  config: AppConfig,
  key: string
): Promise<SyncFile> {
  if (!encrypted) {
    return sanitizeSyncFile(JSON.parse(text) as SyncFile);
  }

  if (!isEncryptionEnabled(config)) {
    throw new Error(`远程 ${key} 已加密，请先在设置页填写加密密码。`);
  }

  try {
    return sanitizeSyncFile(
      await decryptJson<SyncFile>(
        JSON.parse(text) as EncryptedPayload,
        config.encryptionPassword ?? ""
      )
    );
  } catch (error) {
    throw new Error(`远程 ${key} 解密失败，请确认加密密码是否正确。`);
  }
}

async function deleteStaleLatestObject(key: string): Promise<void> {
  try {
    await deleteObjectIfExists(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendSyncLog("info", `当前同步已完成，但清理旧 ${key} 失败：${message}`);
  }
}

async function putLatestAlias(key: string, body: string): Promise<void> {
  try {
    await putObjectText(key, body, {
      cacheControl: MUTABLE_OBJECT_CACHE_CONTROL
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendSyncLog("info", `当前同步已完成，但更新 ${key} 兼容副本失败：${message}`);
  }
}

async function verifyUploadedMetadata(expected: SyncMetadata): Promise<void> {
  let actual: SyncMetadata | null = null;

  for (const delayMs of METADATA_VERIFY_DELAYS_MS) {
    if (delayMs > 0) {
      await delay(delayMs);
    }

    const state = await downloadMetadataState();
    actual = state.metadata;

    if (isSameSyncMetadata(actual, expected)) {
      return;
    }

    if ((actual?.latestRevision ?? 0) > expected.latestRevision) {
      throw new ConditionalWriteError();
    }
  }

  throw new Error(
    [
      `metadata.json 写入后校验失败：期望 r${expected.latestRevision}`,
      `远端仍返回 r${actual?.latestRevision ?? "none"}`,
      "请检查对象存储或 CDN 是否缓存了 metadata.json。"
    ].join("，")
  );
}

function isMutableLatestKey(key: string): boolean {
  return key === LATEST_JSON_KEY || key === LATEST_ENCRYPTED_KEY;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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
