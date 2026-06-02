import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import type { AppConfig, SyncLogEntry } from "../types/bookmark";
import {
  clearLastSyncState,
  clearSyncLogs,
  getConfig,
  getEmptyConfig,
  getSyncLogs,
  isConfigComplete,
  saveConfig
} from "../core/config/configStore";
import { testS3Connection } from "../core/storage/s3Storage";
import { formatLocalDateTime } from "../utils/time";

interface OptionsState {
  config: AppConfig;
  logs: SyncLogEntry[];
  loading: boolean;
  saving: boolean;
  testing: boolean;
  message: string | null;
  error: string | null;
}

const AUTO_SYNC_OPTIONS = [0, 15, 30, 60];

export function Options() {
  const [state, setState] = useState<OptionsState>({
    config: getEmptyConfig(),
    logs: [],
    loading: true,
    saving: false,
    testing: false,
    message: null,
    error: null
  });

  useEffect(() => {
    let isMounted = true;

    async function load() {
      const [savedConfig, logs] = await Promise.all([getConfig(), getSyncLogs()]);

      if (isMounted) {
        setState((current) => ({
          ...current,
          config: savedConfig ?? getEmptyConfig(),
          logs,
          loading: false
        }));
      }
    }

    void load();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveCurrentConfig("配置已保存。");
  }

  async function handleTestConnection() {
    try {
      setState((current) => ({ ...current, testing: true, message: null, error: null }));
      await saveConfig(state.config);
      await testS3Connection();
      setState((current) => ({
        ...current,
        testing: false,
        message: "S3 连接测试成功。",
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        testing: false,
        message: null,
        error: error instanceof Error ? error.message : "S3 连接测试失败。"
      }));
    }
  }

  async function handleClearState() {
    await clearLastSyncState();
    setState((current) => ({
      ...current,
      message: "本地同步状态已清空。",
      error: null
    }));
  }

  async function handleClearLogs() {
    await clearSyncLogs();
    setState((current) => ({
      ...current,
      logs: [],
      message: "同步日志已清空。",
      error: null
    }));
  }

  function updateField<K extends keyof AppConfig>(field: K, value: AppConfig[K]) {
    setState((current) => ({
      ...current,
      config: {
        ...current.config,
        [field]: value
      }
    }));
  }

  async function saveCurrentConfig(message: string) {
    try {
      setState((current) => ({ ...current, saving: true, message: null, error: null }));
      await saveConfig(state.config);
      await sendRuntimeMessage("rescheduleAutoSync");
      setState((current) => ({
        ...current,
        saving: false,
        message: `${message} 如果配置完整，后台会立即同步一次。`,
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        saving: false,
        message: null,
        error: error instanceof Error ? error.message : "保存配置失败。"
      }));
    }
  }

  const disabled = state.loading || state.saving || state.testing;
  const ready = isConfigComplete(state.config);

  return (
    <main className="options">
      <header>
        <h1>S3Marks 设置</h1>
        <p>配置你的 S3 兼容对象存储、端到端加密和自动同步间隔。</p>
      </header>

      <form className="panel" onSubmit={handleSubmit}>
        <div className="grid">
          <TextField
            label="Endpoint"
            value={state.config.endpoint}
            placeholder="https://s3.example.com"
            onChange={(value) => updateField("endpoint", value)}
          />
          <TextField
            label="Region"
            value={state.config.region}
            placeholder="auto"
            onChange={(value) => updateField("region", value)}
          />
          <TextField
            label="Bucket"
            value={state.config.bucket}
            onChange={(value) => updateField("bucket", value)}
          />
          <TextField
            label="Prefix"
            value={state.config.prefix}
            placeholder="s3marks"
            onChange={(value) => updateField("prefix", value)}
          />
          <TextField
            label="Access Key ID"
            value={state.config.accessKeyId}
            onChange={(value) => updateField("accessKeyId", value)}
          />
          <TextField
            label="Secret Access Key"
            type="password"
            value={state.config.secretAccessKey}
            onChange={(value) => updateField("secretAccessKey", value)}
          />
          <TextField
            label="Encryption Password"
            type="password"
            value={state.config.encryptionPassword ?? ""}
            placeholder="留空则不加密"
            onChange={(value) => updateField("encryptionPassword", value)}
          />
          <label className="field">
            <span>定时兜底同步间隔</span>
            <select
              value={state.config.autoSyncIntervalMinutes ?? 0}
              onChange={(event) =>
                updateField("autoSyncIntervalMinutes", Number(event.target.value))
              }
            >
              {AUTO_SYNC_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "关闭定时兜底" : `${value} 分钟`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="checkboxes">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(state.config.forcePathStyle)}
              onChange={(event) => updateField("forcePathStyle", event.target.checked)}
            />
            <span>Force Path Style</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.config.syncOnBookmarkChange !== false}
              onChange={(event) => updateField("syncOnBookmarkChange", event.target.checked)}
            />
            <span>书签变化后自动同步</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.config.syncOnBrowserStartup !== false}
              onChange={(event) => updateField("syncOnBrowserStartup", event.target.checked)}
            />
            <span>浏览器启动后自动同步</span>
          </label>
        </div>

        <div className="actions">
          <button type="submit" disabled={disabled}>
            {state.saving ? "保存中..." : "保存配置"}
          </button>
          <button type="button" disabled={disabled || !ready} onClick={handleTestConnection}>
            {state.testing ? "测试中..." : "测试连接"}
          </button>
          <button type="button" disabled={disabled} onClick={handleClearState}>
            清空本地同步状态
          </button>
        </div>

        {state.message ? <p className="message">{state.message}</p> : null}
        {state.error ? <p className="error">{state.error}</p> : null}
      </form>

      <section className="panel">
        <div className="sectionTitle">
          <h2>同步日志</h2>
          <button type="button" className="secondary" onClick={handleClearLogs}>
            清空日志
          </button>
        </div>
        {state.logs.length === 0 ? (
          <p className="empty">暂无日志。</p>
        ) : (
          <ul className="logs">
            {state.logs.map((log) => (
              <li key={log.id} className={log.level}>
                <time>{formatLocalDateTime(log.createdAt)}</time>
                <span>{log.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

async function sendRuntimeMessage(type: "rescheduleAutoSync"): Promise<void> {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;

  if (!runtime?.sendMessage) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    runtime.sendMessage({ type }, (response: { ok: boolean; error?: string }) => {
      const runtimeError = runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error ?? "后台自动同步配置失败。"));
        return;
      }

      resolve();
    });
  });
}

interface TextFieldProps {
  label: string;
  value: string;
  type?: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function TextField({ label, value, type = "text", placeholder, onChange }: TextFieldProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value);
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={handleChange} />
    </label>
  );
}
