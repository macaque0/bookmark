# S3Marks 书签同步插件

S3Marks 是一个基于 Manifest V3 的浏览器书签同步插件。它通过你自己的 S3 兼容对象存储保存同步文件，可以在 Chrome、Edge、Brave 等浏览器之间同步书签。

当前版本的同步结果会直接写回浏览器原生收藏夹，例如“收藏夹栏 / Bookmarks Bar”和“其他收藏夹 / Other Bookmarks”。插件不会创建或保留特殊托管目录；用户自己创建的任何文件夹都会按普通书签文件夹同步。

## 功能

- 支持 Chrome、Edge、Brave 等 Manifest V3 浏览器。
- 支持 S3 兼容对象存储，例如 AWS S3、腾讯云 COS、Cloudflare R2、MinIO 等。
- popup 只保留一个“立即同步”按钮，日常使用路径简单。
- 首次同步会自动判断远程是否已有数据：
  - 远程为空：上传当前浏览器本地书签，初始化远程同步文件。
  - 远程已有数据：合并本地书签和远程书签，然后写回浏览器并上传新版本。
- 支持自动同步：
  - 保存完整 S3 配置后自动同步一次。
  - 浏览器启动后自动同步一次。
  - 书签变化后延迟约 15 秒自动同步。
  - 默认 60 分钟定时兜底同步，也可在设置页调整或关闭。
- 支持基础三方合并：基于 Base / Local / Remote 合并新增、删除和修改。
- 冲突会保留副本到 `Sync Conflicts/<时间>/Local` 和 `Remote`，避免直接丢数据。
- 支持可选加密：填写加密密码后，同步内容会使用 PBKDF2/SHA-256 + AES-GCM 加密再上传。
- 支持后续切换加密 / 不加密：`metadata.json` 会指向当前有效的同步文件，避免旧 `latest.json` 或 `latest.json.enc` 抢读。
- 支持远程并发保护：上传时会用 `metadata.json` 的 ETag 做条件更新；如果另一个设备已经先写入，当前同步会取消并提示重新同步。
- 同步状态和日志保存在浏览器扩展本地存储中。

## 安装依赖与构建

```bash
npm install
npm run build
```

构建完成后，插件文件会生成到 `dist/` 目录。

如果要运行同步逻辑测试：

```bash
npm run test:sync
```

## 在浏览器中安装插件

### Chrome

1. 打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目下的 `dist` 目录。

### Edge

1. 打开 `edge://extensions/`。
2. 打开左侧或页面上的“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择项目下的 `dist` 目录。

以后每次修改代码并重新执行 `npm run build` 后，都需要在扩展管理页点击插件的“重新加载”。

## 首次使用流程

1. 安装并加载插件。
2. 打开插件设置页。
3. 填写 S3 / COS 配置。
4. 点击“测试连接”，确认对象存储能访问。
5. 点击“保存配置”。
6. 点击 popup 里的“立即同步”，或等待保存配置后的自动同步。
7. 在第二个浏览器中加载同一个插件，并填写同一套 S3 配置。
8. 第二个浏览器点击“立即同步”，即可拉取并合并远程书签。

建议第一次测试时先准备几个不重要的测试书签，确认同步方向和结果符合预期后再正式使用。

## S3 / COS 配置说明

设置页中的字段含义如下：

| 字段 | 说明 |
| --- | --- |
| Endpoint | S3 服务 API 地址，不是具体桶的访问域名。腾讯云 COS 北京地域通常填 `https://cos.ap-beijing.myqcloud.com`。 |
| Region | 存储桶地域，例如腾讯云 COS 北京填 `ap-beijing`。 |
| Bucket | 存储桶名称，例如 `my-bookmark-bucket`。不要把 `https://` 或域名一起填进去。 |
| Access Key ID | 对象存储访问密钥 ID。 |
| Secret Access Key | 对象存储访问密钥 Secret。 |
| Prefix | 对象存储中的文件前缀，类似目录名。可为空；建议填 `s3marks`，方便和桶内其他文件区分。 |
| Force Path Style | 是否强制使用 path-style 访问。腾讯云 COS 通常不用勾选；MinIO 或某些私有 S3 服务可能需要勾选。 |
| 加密密码 | 可选。留空就是明文同步；填写后会加密远程书签内容。 |

### 腾讯云 COS 示例

如果桶名是 `bookmark-xxxx`，地域是北京，那么通常这样填：

```txt
Endpoint: https://cos.ap-beijing.myqcloud.com
Region: ap-beijing
Bucket: bookmark-xxxx
Prefix: s3marks
Force Path Style: 不勾选
```

对象存储权限至少需要能读取和写入对象。建议包含：

- `HeadBucket`
- `GetObject`
- `PutObject`
- `DeleteObject`

其中 `DeleteObject` 用于清理旧的 `latest.json` 或 `latest.json.enc`。如果没有删除权限，同步本身仍会尽量完成，但设置页日志里可能会出现旧 latest 清理失败的提示。

## 同步文件结构

如果 `Prefix` 填了 `s3marks`，对象存储里大致会出现：

```txt
s3marks/metadata.json
s3marks/latest.json
s3marks/history/000001-<deviceId>-<timestamp>.json
```

启用加密后会变成：

```txt
s3marks/metadata.json
s3marks/latest.json.enc
s3marks/history/000002-<deviceId>-<timestamp>.json.enc
```

`metadata.json` 是同步时的权威指针，记录当前最新版本信息，包括：

- `latestRevision`：最新 revision 编号。
- `latestUpdatedAt`：最新更新时间。
- `latestDeviceId`：最后上传的设备 ID。
- `latestObjectKey`：当前应读取的同步文件。新版通常指向不可变 history 文件，例如 `history/000002-<deviceId>-<timestamp>.json.enc`；旧数据也兼容 `latest.json` 或 `latest.json.enc`。
- `latestEncrypted`：当前 latest 文件是否加密。

上传时会先写入唯一的 history 文件，再用对象存储返回的 ETag 条件更新 `metadata.json`。如果两个浏览器同时同步，只有先完成条件更新的一方会成功；另一方会提示远程已更新，需要重新同步后再合并。

浏览器插件需要对象存储的 CORS 规则允许读取 `ETag` 响应头，并允许 `If-Match` / `If-None-Match` 请求头。否则插件无法在浏览器里拿到 `metadata.json` 的 ETag，只能在写入前复查 metadata 后降级更新；同步仍会继续，但并发保护会弱一些。若设置页日志出现“metadata.json 未返回 ETag”，请在对象存储 CORS 的 `ExposeHeaders` 中加入 `ETag`。

`metadata.json` 和 `latest.json` 属于可变对象，插件会使用禁用缓存的请求读取并在上传后校验 revision，避免浏览器、CDN 或对象存储缓存返回旧版本。设置页日志也会记录新增、删除、修改、移动、排序和导入等书签变化及其自动同步调度结果。

## 加密说明

加密密码为空时，同步内容以明文 JSON 写入对象存储。

填写加密密码后，插件会在上传前加密书签同步文件。其他浏览器想读取同一份远程数据，必须填写相同的加密密码。

后续可以在加密和不加密之间切换：

- 明文切换到加密：新上传的 history 文件会变成 `.json.enc`，`metadata.json` 会指向它。
- 加密切换到明文：新上传的 history 文件会变成 `.json`，`metadata.json` 会指向它。
- 插件会通过 `metadata.json` 读取当前有效文件，不会因为旧 latest 文件残留而读错。
- 上传后会尝试更新当前模式的 latest 兼容副本，并删除另一种旧 latest 文件。

如果另一个浏览器填了错误密码，同步会报错并中断，提示类似：

```txt
远程 latest.json.enc 解密失败，请确认加密密码是否正确。
```

错误密码不会继续覆盖远程同步文件。

注意：旧的 `history/*.json` 明文历史文件不会自动批量清理。如果你曾经用明文模式同步过，又特别在意历史明文数据，可以在 COS 控制台手动删除旧 history，或后续增加清理功能。

## 同步行为说明

S3Marks 会把不同浏览器的根目录名称标准化：

- `收藏夹栏`、`书签栏`、`Favorites Bar`、`Bookmarks Bar` 会统一为 `Bookmarks Bar`。
- `其他收藏夹`、`其他书签`、`Other Favorites`、`Other Bookmarks` 会统一为 `Other Bookmarks`。

同步时会读取本地书签、远程书签和上一次同步基线，然后进行合并。合并完成后，结果会写回浏览器原生收藏夹根目录。

`S3Marks` 不是保留文件夹名。如果你自己创建了这个文件夹，它会和其他普通文件夹一样参与同步。

## 常见问题

### Prefix 可以为空吗？

可以。为空时，`metadata.json`、`latest.json` 等文件会直接放在桶根目录。

更推荐填写一个前缀，例如 `s3marks`，这样对象存储里更清楚，也不容易和其他文件混在一起。

### Endpoint 应该填桶域名吗？

通常不填桶访问域名，而是填 S3 / COS 服务 API 地址。

以腾讯云 COS 北京地域为例，通常填：

```txt
https://cos.ap-beijing.myqcloud.com
```

桶名放到 `Bucket` 字段里单独填写。

### Force Path Style 是什么？

它控制 S3 SDK 的访问 URL 风格：

- 不勾选：通常使用 virtual-hosted-style，适合 AWS S3、腾讯云 COS 等服务。
- 勾选：使用 path-style，常见于 MinIO 或部分自建 S3 服务。

腾讯云 COS 一般不需要勾选。

### 为什么书签变化后不是立刻同步？

插件会延迟约 15 秒同步，这是防抖处理。连续新增、删除、移动多个书签时，插件会等操作基本结束后再同步，避免频繁上传和互相触发循环。

### 两个浏览器同步结果不一样怎么办？

建议按这个顺序排查：

1. 确认两个浏览器都加载了最新构建后的 `dist`。
2. 确认两个浏览器的 S3 配置完全一致，尤其是 Endpoint、Region、Bucket、Prefix。
3. 如果启用了加密，确认加密密码一致。
4. 两边分别点击一次“立即同步”。
5. 打开设置页查看同步日志里的错误信息。
6. 检查对象存储中的 `metadata.json`，确认 `latestObjectKey` 指向当前有效的同步文件。

### 可以创建名为 S3Marks 的文件夹吗？

可以。`S3Marks` 只是插件名称，不是同步保留目录名。你创建的同名文件夹会按普通文件夹同步和写回。

## 安全说明

- S3Marks 不会把 Access Key 写入源码。
- S3 配置和加密密码保存在浏览器扩展的本地存储中。
- 明文模式下，远程 history 文件和 latest 兼容副本可以直接看到书签标题和 URL。
- 加密模式下，远程同步内容会加密保存；忘记密码后，已加密的远程数据无法恢复。
- 请给对象存储密钥配置尽量小的权限范围，只允许访问用于同步的桶或前缀。

## 开发命令

```bash
npm install       # 安装依赖
npm run build    # 类型检查并构建 dist
npm run test:sync # 运行同步逻辑测试
npm run package:extension # 生成 GitHub Release 用 zip
```

`dist/` 和 `node_modules/` 不提交到 Git。发布或本地安装插件时，重新运行 `npm run build` 后加载 `dist/` 即可。

## GitHub Release 发布

如果不发布到插件市场，可以把构建后的插件 zip 上传到 GitHub Release，用户下载后在 Chrome 或 Edge 开发者模式中手动加载。

生成上传包：

```bash
npm run build
npm run package:extension
```

生成的 zip 位于 `release/` 目录，例如：

```txt
release/s3marks-v0.1.0.zip
```

GitHub Release 使用方式：

1. 在 GitHub 仓库中创建新的 Release。
2. 上传 `release/s3marks-v0.1.0.zip` 作为附件。
3. 用户下载 zip 后解压到本地目录。
4. 在 Chrome 或 Edge 扩展管理页打开开发者模式。
5. 点击“加载已解压的扩展程序 / 加载解压缩的扩展”，选择解压后的目录。

注意：浏览器不能直接安装这个 zip，需要先解压再加载解压后的目录。
