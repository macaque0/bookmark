export type BookmarkEventDecision = "handle" | "defer" | "ignore";

export interface BookmarkEventGateState {
  applyingSyncedBookmarks: boolean;
  suppressBookmarkEventsUntil: number;
}

export function getBookmarkEventDecision(
  state: BookmarkEventGateState,
  now = Date.now()
): BookmarkEventDecision {
  if (state.applyingSyncedBookmarks) {
    return "ignore";
  }

  if (now < state.suppressBookmarkEventsUntil) {
    return "defer";
  }

  return "handle";
}

export function getDeferredBookmarkChangeDelayMinutes(
  suppressBookmarkEventsUntil: number,
  debounceMinutes: number,
  now = Date.now()
): number {
  const remainingMs = Math.max(suppressBookmarkEventsUntil - now, 0);
  const remainingMinutes = remainingMs / 60_000;

  return Math.max(debounceMinutes, remainingMinutes);
}
