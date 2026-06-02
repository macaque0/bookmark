type BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;
type BookmarkCreateArg = chrome.bookmarks.BookmarkCreateArg;

function getBrowserBookmarksApi(): Record<string, (...args: unknown[]) => unknown> | null {
  const webExtensionApi = (globalThis as { browser?: { bookmarks?: unknown } }).browser;

  if (webExtensionApi?.bookmarks) {
    return webExtensionApi.bookmarks as Record<string, (...args: unknown[]) => unknown>;
  }

  if (globalThis.chrome?.bookmarks) {
    return chrome.bookmarks as unknown as Record<string, (...args: unknown[]) => unknown>;
  }

  return null;
}

function hasPromiseBookmarksApi(): boolean {
  return Boolean((globalThis as { browser?: { bookmarks?: unknown } }).browser?.bookmarks);
}

async function callBookmarksApi<T>(methodName: string, ...args: unknown[]): Promise<T> {
  const api = getBrowserBookmarksApi();

  if (!api?.[methodName]) {
    throw new Error("Bookmarks API is only available inside a browser extension context.");
  }

  if (hasPromiseBookmarksApi()) {
    return api[methodName](...args) as Promise<T>;
  }

  return new Promise<T>((resolve, reject) => {
    api[methodName](...args, (result: T) => {
      const runtimeError = chrome.runtime?.lastError;

      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(result);
    });
  });
}

export async function getBrowserBookmarkTree(): Promise<BookmarkTreeNode[]> {
  return callBookmarksApi<BookmarkTreeNode[]>("getTree");
}

export async function createFolder(
  parentId: string,
  title: string,
  index?: number
): Promise<string> {
  const node = await callBookmarksApi<BookmarkTreeNode>("create", {
    parentId,
    title,
    index
  } satisfies BookmarkCreateArg);

  return node.id;
}

export async function createBookmark(
  parentId: string,
  title: string,
  url: string,
  index?: number
): Promise<string> {
  const node = await callBookmarksApi<BookmarkTreeNode>("create", {
    parentId,
    title,
    url,
    index
  } satisfies BookmarkCreateArg);

  return node.id;
}

export async function updateBookmark(
  id: string,
  changes: { title?: string; url?: string }
): Promise<void> {
  await callBookmarksApi<BookmarkTreeNode>("update", id, changes);
}

export async function moveBookmark(
  id: string,
  destination: { parentId?: string; index?: number }
): Promise<void> {
  await callBookmarksApi<BookmarkTreeNode>("move", id, destination);
}

export async function removeBookmarkTree(id: string): Promise<void> {
  await callBookmarksApi<void>("removeTree", id);
}
