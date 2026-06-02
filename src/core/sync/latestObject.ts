import type { SyncFile, SyncMetadata } from "../../types/bookmark";

export const LATEST_JSON_KEY = "latest.json";
export const LATEST_ENCRYPTED_KEY = "latest.json.enc";
export const METADATA_KEY = "metadata.json";

export interface LatestSyncFileCandidate {
  key: string;
  syncFile: SyncFile;
}

export function getMetadataLatestKey(metadata: SyncMetadata | null): string | null {
  const key = metadata?.latestObjectKey?.trim();

  if (key === LATEST_JSON_KEY || key === LATEST_ENCRYPTED_KEY) {
    return key;
  }

  return null;
}

export function isEncryptedLatestKey(key: string, metadata: SyncMetadata | null): boolean {
  return metadata?.latestEncrypted ?? key.endsWith(".enc");
}

export function shouldUsePlaintextBeforeEncrypted(
  metadata: SyncMetadata | null,
  plaintextSyncFile: SyncFile | null
): boolean {
  return Boolean(plaintextSyncFile && metadata?.latestRevision === plaintextSyncFile.revision);
}

export function chooseLegacyLatestSyncFile(
  metadata: SyncMetadata | null,
  candidates: LatestSyncFileCandidate[]
): SyncFile | null {
  const metadataCandidate = candidates.find(
    (candidate) => candidate.syncFile.revision === metadata?.latestRevision
  );

  if (metadataCandidate) {
    return metadataCandidate.syncFile;
  }

  return [...candidates].sort(
    (left, right) => right.syncFile.revision - left.syncFile.revision
  )[0]?.syncFile ?? null;
}

export function getStaleLatestKey(currentLatestKey: string): string {
  return currentLatestKey === LATEST_ENCRYPTED_KEY ? LATEST_JSON_KEY : LATEST_ENCRYPTED_KEY;
}
