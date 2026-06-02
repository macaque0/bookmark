import { useEffect, useState } from "react";
import type { SyncStatus } from "../types/bookmark";
import { getBrowserBookmarkTree } from "../core/bookmarks/browserBookmarks";
import { countBookmarks, normalizeBookmarkTree } from "../core/bookmarks/normalizeBookmarks";
import { getConfig, getSyncStatus, isConfigComplete } from "../core/config/configStore";
import { logger } from "../utils/logger";
import { formatLocalDateTime } from "../utils/time";

interface PopupState {
  loading: boolean;
  busy: boolean;
  configured: boolean;
  bookmarkCount: number | null;
  status: SyncStatus | null;
  error: string | null;
}

export function App() {
  const [state, setState] = useState<PopupState>({
    loading: true,
    busy: false,
    configured: false,
    bookmarkCount: null,
    status: null,
    error: null
  });

  useEffect(() => {
    let isMounted = true;

    async function loadBookmarks() {
      try {
        const [rawTree, config, status] = await Promise.all([
          getBrowserBookmarkTree(),
          getConfig(),
          getSyncStatus()
        ]);
        const normalizedTree = normalizeBookmarkTree(rawTree);

        logger.info("Normalized bookmark tree", normalizedTree);

        if (isMounted) {
          setState({
            loading: false,
            busy: false,
            configured: isConfigComplete(config),
            bookmarkCount: countBookmarks(normalizedTree),
            status,
            error: null
          });
        }
      } catch (error) {
        if (isMounted) {
          setState({
            loading: false,
            busy: false,
            configured: false,
            bookmarkCount: null,
            status: null,
            error: error instanceof Error ? error.message : "读取书签失败"
          });
        }
      }
    }

    void loadBookmarks();

    return () => {
      isMounted = false;
    };
  }, []);

  async function runSyncNow() {
    try {
      setState((current) => ({ ...current, busy: true, error: null }));
      const status = await sendBackgroundMessage<SyncStatus>("syncNow");
      const rawTree = await getBrowserBookmarkTree();
      const normalizedTree = normalizeBookmarkTree(rawTree);

      setState((current) => ({
        ...current,
        busy: false,
        status,
        bookmarkCount: countBookmarks(normalizedTree),
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "同步失败"
      }));
    }
  }

  function openOptionsPage() {
    const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;

    if (runtime?.openOptionsPage) {
      void runtime.openOptionsPage();
    }
  }

  const lastSyncText = formatLocalDateTime(state.status?.lastSyncAt);
  const disabled = state.loading || state.busy || !state.configured;

  return (
    <main className="popup">
      <header>
        <h1>S3Marks</h1>
        <p>通过 S3 兼容对象存储同步浏览器书签。</p>
      </header>

      <section className="status">
        <span className="label">本地书签</span>
        <strong>
          {state.loading
            ? "读取中..."
            : state.bookmarkCount === null
              ? "-"
              : `${state.bookmarkCount} 个`}
        </strong>
      </section>

      <section className="status">
        <span className="label">状态</span>
        <strong className={state.status?.level === "error" ? "danger" : ""}>
          {state.configured ? state.status?.message ?? "已配置" : "未配置"}
        </strong>
      </section>

      <section className="status">
        <span className="label">最近同步</span>
        <strong>{lastSyncText}</strong>
      </section>

      <div className="actions">
        <button disabled={disabled} onClick={() => void runSyncNow()}>
          {state.busy ? "同步中..." : "立即同步"}
        </button>
        <button className="secondary" onClick={openOptionsPage}>
          设置
        </button>
      </div>

      {state.error ? <p className="error">{state.error}</p> : null}
    </main>
  );
}

async function sendBackgroundMessage<T>(type: "syncNow"): Promise<T> {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;

  if (!runtime?.sendMessage) {
    throw new Error("后台同步只能在扩展环境中运行。");
  }

  return new Promise<T>((resolve, reject) => {
    runtime.sendMessage({ type }, (response: { ok: boolean; data?: T; error?: string }) => {
      const runtimeError = runtime.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error ?? "后台同步失败"));
        return;
      }

      resolve(response.data as T);
    });
  });
}
