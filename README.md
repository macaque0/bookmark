# S3Marks

S3Marks is a WebExtension / Manifest V3 browser extension for syncing bookmarks through user-owned S3-compatible object storage.

## Features

- Chrome / Edge / Brave compatible Manifest V3 build.
- Cross-browser Bookmarks API wrapper with normalized bookmark tree output.
- S3-compatible storage configuration in the Options page.
- Manual two-way sync from the popup.
- First-run sync automatically initializes S3 when remote data is empty, or imports existing remote data when the browser has no local sync baseline.
- Automatic sync after saving a complete S3 config.
- Automatic sync shortly after browser startup.
- Debounced automatic sync after bookmark changes, with scheduled sync as a fallback.
- Sync results are written back to the browser's native bookmark roots such as Bookmarks Bar and Other Bookmarks.
- Legacy managed `S3Marks` folders are migrated into native roots and removed during sync.
- Basic base/local/remote merge with conflict copies under `Sync Conflicts/<timestamp>/Local` and `Remote`.
- Optional AES-GCM encryption using PBKDF2/SHA-256 before writing sync files to S3.
- Encryption can be switched on or off later; `metadata.json` points to the active latest object.
- Configurable automatic sync interval: off, 15, 30, or 60 minutes.
- Local sync status and log storage through `chrome.storage.local`.

## Development

```bash
npm install
npm run build
```

## Load In Browser

1. Run `npm run build`.
2. Open Chrome, Edge, or Brave extension management.
3. Enable developer mode.
4. Load unpacked extension from `dist`.

## S3 Files

By default, files are stored under the configured prefix:

```txt
latest.json
metadata.json
history/000001.json
```

When an encryption password is configured, bookmark payloads use:

```txt
latest.json.enc
metadata.json
history/000001.json.enc
```

`metadata.json` records the current latest object name and encryption state, so switching between encrypted and unencrypted sync does not accidentally read a stale `latest.json` or `latest.json.enc`. After each upload, S3Marks also tries to delete the opposite old latest file.

## Safety Notes

S3Marks does not write access keys into source code. It stores S3 credentials and the optional encryption password only in local browser extension storage. Sync operations merge local and remote bookmark trees before writing the result back to the browser's native bookmark roots.
