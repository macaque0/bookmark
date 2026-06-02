export type BookmarkNodeType = "folder" | "bookmark";

export interface NormalizedBookmarkNode {
  id: string;
  type: BookmarkNodeType;
  title: string;
  url?: string;
  children?: NormalizedBookmarkNode[];
  path: string;
  index: number;
  createdAt?: string;
  updatedAt?: string;
  deleted?: boolean;
  deletedAt?: string;
}

export interface SyncFile {
  schemaVersion: 1;
  revision: number;
  deviceId: string;
  updatedAt: string;
  tree: NormalizedBookmarkNode[];
}

export interface SyncMetadata {
  schemaVersion: 1;
  latestRevision: number;
  latestUpdatedAt: string;
  latestDeviceId: string;
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle?: boolean;
}

export interface AppConfig extends S3Config {
  encryptionPassword?: string;
  autoSyncIntervalMinutes?: number;
  syncOnBookmarkChange?: boolean;
  syncOnBrowserStartup?: boolean;
  syncAfterConfigSave?: boolean;
}

export interface EncryptedPayload {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "PBKDF2";
  salt: string;
  iv: string;
  data: string;
}

export interface SyncConflict {
  id: string;
  reason: string;
  base?: NormalizedBookmarkNode;
  local?: NormalizedBookmarkNode;
  remote?: NormalizedBookmarkNode;
}

export type SyncStatusLevel = "idle" | "running" | "success" | "error";

export interface SyncStatus {
  level: SyncStatusLevel;
  message: string;
  lastSyncAt?: string;
  lastError?: string;
  bookmarkCount?: number;
  remoteBookmarkCount?: number;
  conflictCount?: number;
}

export interface SyncLogEntry {
  id: string;
  createdAt: string;
  level: "info" | "error";
  message: string;
}
