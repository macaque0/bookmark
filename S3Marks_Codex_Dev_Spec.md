# S3Marks Codex 开发文档

> 基于 S3 协议的跨浏览器书签同步浏览器插件。  
> 目标：支持 Chrome / Edge / Brave / Firefox，通过用户自己的 S3 兼容对象存储同步书签，并完整保留文件夹结构。

---

## 1. 项目目标

开发一个浏览器扩展，用于同步不同浏览器、不同设备之间的书签。

核心要求：

- 支持主流浏览器
  - Chrome
  - Edge
  - Brave
  - Firefox
- 使用 WebExtension / Manifest V3 开发
- 使用浏览器 Bookmarks API 读取、创建、修改、删除书签
- 使用 S3 兼容协议同步数据
- 保留完整书签文件夹结构
- 支持手动同步
- 支持自动同步
- 支持基础冲突处理
- 支持端到端加密
- 不依赖自建服务端

---

## 2. 技术选型

### 2.1 前端技术

```txt
TypeScript
React
Vite
WebExtension
Manifest V3
```

### 2.2 浏览器 API

使用浏览器书签 API：

```ts
chrome.bookmarks
browser.bookmarks
```

兼容策略：

```ts
const bookmarksApi = globalThis.browser?.bookmarks ?? chrome.bookmarks;
```

### 2.3 S3 SDK

使用 AWS SDK v3：

```bash
npm install @aws-sdk/client-s3
```

主要使用：

```ts
S3Client
GetObjectCommand
PutObjectCommand
HeadObjectCommand
```

### 2.4 加密

使用浏览器内置 Web Crypto API：

```txt
AES-GCM
PBKDF2
SHA-256
```

---

## 3. 项目目录结构

建议 Codex 按以下结构生成项目：

```txt
s3marks/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── manifest.json
│   └── icons/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
├── src/
│   ├── background/
│   │   └── index.ts
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── App.tsx
│   ├── options/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── Options.tsx
│   ├── core/
│   │   ├── bookmarks/
│   │   │   ├── browserBookmarks.ts
│   │   │   ├── normalizeBookmarks.ts
│   │   │   └── applyBookmarkTree.ts
│   │   ├── sync/
│   │   │   ├── syncEngine.ts
│   │   │   ├── merge.ts
│   │   │   └── diff.ts
│   │   ├── storage/
│   │   │   ├── s3Client.ts
│   │   │   └── s3Storage.ts
│   │   ├── crypto/
│   │   │   ├── encrypt.ts
│   │   │   └── keyDerivation.ts
│   │   └── config/
│   │       └── configStore.ts
│   ├── types/
│   │   └── bookmark.ts
│   └── utils/
│       ├── uuid.ts
│       ├── logger.ts
│       └── time.ts
└── README.md
```

---

## 4. Manifest 配置

`public/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "S3Marks",
  "version": "0.1.0",
  "description": "Sync browser bookmarks with S3-compatible storage.",
  "permissions": [
    "bookmarks",
    "storage",
    "alarms"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "action": {
    "default_popup": "src/popup/index.html",
    "default_title": "S3Marks"
  },
  "options_page": "src/options/index.html",
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

说明：

- `bookmarks`：读取和修改浏览器书签
- `storage`：保存 S3 配置、本地快照、同步状态
- `alarms`：实现自动同步
- `host_permissions`：访问用户配置的 S3 endpoint

---

## 5. 数据模型

### 5.1 BookmarkNode

```ts
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
```

### 5.2 SyncFile

```ts
export interface SyncFile {
  schemaVersion: 1;
  revision: number;
  deviceId: string;
  updatedAt: string;
  tree: NormalizedBookmarkNode[];
}
```

### 5.3 SyncMetadata

```ts
export interface SyncMetadata {
  schemaVersion: 1;
  latestRevision: number;
  latestUpdatedAt: string;
  latestDeviceId: string;
}
```

### 5.4 S3Config

```ts
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle?: boolean;
}
```

---

## 6. S3 文件结构

默认存储路径：

```txt
s3://<bucket>/<prefix>/
├── latest.json
├── metadata.json
├── base.json
└── history/
    ├── 000001.json
    ├── 000002.json
    └── 000003.json
```

说明：

| 文件 | 作用 |
|---|---|
| `latest.json` | 最新同步数据 |
| `metadata.json` | 同步元信息 |
| `base.json` | 当前设备上次同步基线 |
| `history/*.json` | 历史版本，用于恢复 |

如果开启加密：

```txt
latest.json.enc
metadata.json
base.json.enc
history/000001.json.enc
```

---

## 7. 同步策略

### 7.1 MVP 同步模式

第一版实现：

- 手动上传
- 手动下载
- 手动双向同步
- 自动定时同步

不要第一版就做实时监听，否则误删和冲突会变复杂。

---

### 7.2 三方合并

同步时使用三份数据：

```txt
Base   = 上次同步成功后的快照
Local  = 当前浏览器本地书签
Remote = S3 上的 latest.json
```

合并流程：

```txt
1. 读取 Base
2. 读取 Local
3. 下载 Remote
4. 对比 Base -> Local 的变更
5. 对比 Base -> Remote 的变更
6. 合并非冲突变更
7. 冲突内容放入 Sync Conflicts 文件夹
8. 写入本地浏览器
9. 上传新的 latest.json
10. 更新 Base
```

---

## 8. 去重和文件夹结构保留

不要只按 URL 去重。

书签唯一性建议使用：

```txt
path + title + url
```

例如：

```txt
/开发/GitHub
/资料/GitHub
```

即使 URL 都是：

```txt
https://github.com
```

也应该保留两个书签。

---

## 9. 冲突处理

### 9.1 自动合并

可以自动合并的情况：

- 本地新增，远程未改
- 远程新增，本地未改
- 本地删除，远程未改
- 远程删除，本地未改
- 本地修改标题，远程未改
- 远程修改标题，本地未改

### 9.2 冲突场景

需要保留两边：

- 本地和远程同时修改同一个书签
- 本地和远程同时移动同一个文件夹
- 本地删除，远程修改
- 本地修改，远程删除

### 9.3 冲突文件夹

冲突内容放入：

```txt
Sync Conflicts/
└── 2026-06-02 10-30-00/
    ├── Local/
    └── Remote/
```

---

## 10. 删除策略

采用软删除，避免误删扩散。

```ts
{
  deleted: true,
  deletedAt: "2026-06-02T10:30:00Z"
}
```

MVP 阶段可以：

- 同步时标记删除
- 保留 30 天
- 后续再实现永久清理

---

## 11. 加密设计

### 11.1 加密目标

S3 服务商无法读取用户书签。

### 11.2 密钥派生

```txt
用户输入密码
↓
PBKDF2 + salt
↓
AES-GCM key
```

### 11.3 加密文件格式

```ts
export interface EncryptedPayload {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "PBKDF2";
  salt: string;
  iv: string;
  data: string;
}
```

其中：

- `salt` 使用 base64
- `iv` 使用 base64
- `data` 使用 base64

---

## 12. 核心模块说明

### 12.1 browserBookmarks.ts

职责：

- 读取浏览器书签树
- 创建文件夹
- 创建书签
- 删除书签
- 移动书签
- 更新书签标题和 URL

需要导出：

```ts
export async function getBrowserBookmarkTree(): Promise<chrome.bookmarks.BookmarkTreeNode[]>;

export async function createFolder(parentId: string, title: string, index?: number): Promise<string>;

export async function createBookmark(parentId: string, title: string, url: string, index?: number): Promise<string>;

export async function updateBookmark(id: string, changes: { title?: string; url?: string }): Promise<void>;

export async function removeBookmarkTree(id: string): Promise<void>;
```

---

### 12.2 normalizeBookmarks.ts

职责：

- 将浏览器原始书签树转换为统一格式
- 生成 path
- 保留 index
- 过滤浏览器内置根目录差异

导出：

```ts
export function normalizeBookmarkTree(rawTree: unknown[]): NormalizedBookmarkNode[];
```

---

### 12.3 applyBookmarkTree.ts

职责：

- 将合并后的书签树写入浏览器
- 尽量增量更新
- MVP 可以先清空指定同步根目录再重建

建议 MVP 只管理一个根目录：

```txt
S3Marks
```

不要直接覆盖全部书签栏，避免危险。

---

### 12.4 s3Client.ts

职责：

- 创建 S3Client
- 支持自定义 endpoint
- 支持 forcePathStyle

导出：

```ts
export function createS3Client(config: S3Config): S3Client;
```

---

### 12.5 s3Storage.ts

职责：

- 上传 JSON
- 下载 JSON
- 检测文件是否存在
- 上传历史版本

导出：

```ts
export async function getObjectText(key: string): Promise<string | null>;

export async function putObjectText(key: string, body: string): Promise<void>;

export async function objectExists(key: string): Promise<boolean>;
```

---

### 12.6 syncEngine.ts

职责：

- 组织完整同步流程
- 读取配置
- 读取本地
- 下载远程
- 合并
- 写入本地
- 上传远程
- 写同步日志

导出：

```ts
export async function uploadOnly(): Promise<void>;

export async function downloadOnly(): Promise<void>;

export async function syncNow(): Promise<void>;
```

---

### 12.7 merge.ts

职责：

- 三方合并
- 返回合并结果和冲突列表

导出：

```ts
export interface MergeResult {
  tree: NormalizedBookmarkNode[];
  conflicts: SyncConflict[];
}

export async function mergeBookmarkTrees(
  base: NormalizedBookmarkNode[],
  local: NormalizedBookmarkNode[],
  remote: NormalizedBookmarkNode[]
): Promise<MergeResult>;
```

---

### 12.8 configStore.ts

职责：

- 保存配置
- 读取配置
- 保存同步状态

建议使用：

```ts
chrome.storage.local
```

导出：

```ts
export async function getConfig(): Promise<S3Config | null>;

export async function saveConfig(config: S3Config): Promise<void>;

export async function getLastSyncState(): Promise<SyncFile | null>;

export async function saveLastSyncState(state: SyncFile): Promise<void>;
```

---

## 13. 页面设计

### 13.1 Popup 页面

功能：

- 显示同步状态
- 手动同步按钮
- 上传按钮
- 下载按钮
- 最近同步时间
- 打开设置页

界面示例：

```txt
S3Marks

状态：已配置
最近同步：2026-06-02 10:30

[立即同步]
[上传本地到 S3]
[从 S3 下载]
[设置]
```

---

### 13.2 Options 页面

功能：

- 配置 S3
- 测试连接
- 配置加密密码
- 配置自动同步间隔
- 查看日志

字段：

```txt
Endpoint
Region
Bucket
Prefix
Access Key ID
Secret Access Key
Force Path Style
Encryption Password
Auto Sync Interval
```

按钮：

```txt
保存配置
测试连接
清空本地同步状态
```

---

## 14. MVP 开发任务

### Task 1：初始化项目

目标：

- 创建 Vite + React + TypeScript 项目
- 配置 Manifest V3
- 配置 popup 和 options 页面
- 能在 Chrome 开发者模式加载插件

验收标准：

- 插件能正常加载
- 点击插件图标能打开 popup
- 设置页能打开

---

### Task 2：读取书签

目标：

- 使用 Bookmarks API 读取浏览器书签树
- 在 popup 中显示书签数量
- 在 console 输出标准化后的书签树

验收标准：

- 能读取文件夹
- 能读取书签
- 能保留层级结构
- 能生成统一 NormalizedBookmarkNode

---

### Task 3：S3 配置页

目标：

- 实现 Options 页面
- 保存 S3 配置到 chrome.storage.local
- 支持测试连接

验收标准：

- 配置能保存
- 刷新后配置仍存在
- 测试连接成功/失败有提示

---

### Task 4：上传书签到 S3

目标：

- 将本地书签标准化
- 生成 latest.json
- 上传到 S3

验收标准：

- S3 中出现 latest.json
- JSON 内容可读
- 文件夹结构完整

---

### Task 5：从 S3 下载书签

目标：

- 下载 latest.json
- 解析 JSON
- 显示远程书签统计

验收标准：

- 能下载文件
- 能解析文件
- 错误时显示提示

---

### Task 6：导入到浏览器

目标：

- 将远程书签写入浏览器
- MVP 阶段统一导入到根目录 `S3Marks`

验收标准：

- 浏览器出现 `S3Marks` 文件夹
- 文件夹内结构与远程 JSON 一致
- 不影响用户原有书签栏

---

### Task 7：手动同步

目标：

- 实现 uploadOnly
- 实现 downloadOnly
- 实现 syncNow

验收标准：

- popup 中按钮可用
- 同步成功后显示时间
- 同步失败显示错误

---

### Task 8：基础三方合并

目标：

- 保存 base 快照
- 对比 local / remote
- 合并新增内容
- 冲突放入 Sync Conflicts

验收标准：

- 两台设备新增不同书签后能合并
- 同名冲突不会丢失
- 删除不会误删远程新增内容

---

### Task 9：加密

目标：

- 实现 AES-GCM 加密
- 上传前加密
- 下载后解密

验收标准：

- S3 文件不可直接阅读
- 密码正确可以同步
- 密码错误提示失败

---

### Task 10：自动同步

目标：

- 使用 chrome.alarms 定时触发同步
- 支持配置同步间隔

验收标准：

- 可设置 15 / 30 / 60 分钟
- 到时间自动同步
- 后台同步失败有日志

---

## 15. Codex 开发提示词

可以直接复制给 Codex：

```txt
请基于以下要求开发一个浏览器插件项目，项目名为 S3Marks。

技术栈：
- TypeScript
- React
- Vite
- Manifest V3
- WebExtension API
- @aws-sdk/client-s3
- Web Crypto API

目标：
开发一个跨浏览器书签同步插件，支持 Chrome、Edge、Brave、Firefox，通过 S3 兼容对象存储同步书签，并完整保留文件夹结构。

请优先完成 MVP：
1. 初始化 Vite + React + TypeScript + Manifest V3 插件项目
2. 实现 popup 页面和 options 设置页面
3. 使用 bookmarks API 读取浏览器书签树
4. 将书签转换为统一 JSON 格式
5. 实现 S3 配置保存
6. 实现上传 latest.json 到 S3
7. 实现从 S3 下载 latest.json
8. 实现导入到浏览器的 S3Marks 根目录
9. 实现手动同步按钮
10. 保留文件夹层级结构

项目目录请使用：
src/background
src/popup
src/options
src/core/bookmarks
src/core/sync
src/core/storage
src/core/crypto
src/core/config
src/types
src/utils

注意：
- MVP 阶段不要直接覆盖用户原有全部书签
- 导入内容统一放到 S3Marks 根目录
- URL 相同但文件夹路径不同的书签不能去重
- S3 endpoint、bucket、region、accessKey、secretKey、prefix 都应由用户配置
- 支持 S3 兼容服务，因此 S3Client 需要支持 endpoint 和 forcePathStyle
- 所有核心逻辑使用 TypeScript 类型
- 给出可运行的 package.json、vite.config.ts、manifest.json
```

---

## 16. 安全注意事项

- 不要把 Access Key 写死在代码里
- S3 Secret 只保存在本地浏览器存储中
- 后续可以考虑使用浏览器密码管理器或系统密钥链
- 开启加密后，远程文件只保存密文
- 默认不要上传用户未确认的数据
- 默认不要清空用户原始书签

---

## 17. 参考资料

- Chrome Bookmarks API: https://developer.chrome.com/docs/extensions/reference/api/bookmarks
- MDN WebExtensions Bookmarks API: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/bookmarks
- AWS SDK for JavaScript v3 S3 Client: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
- AWS SDK for JavaScript v3 Browser Usage: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html

---

## 18. 第一版验收目标

完成后应满足：

- 浏览器插件能正常安装
- 用户能配置 S3
- 用户能读取本地书签
- 用户能上传书签到 S3
- 用户能从 S3 下载书签
- 用户能导入到 `S3Marks` 根目录
- 文件夹结构完整保留
- 不破坏原有书签
- 代码结构清晰，方便继续扩展
