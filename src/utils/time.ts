export function nowIso(): string {
  return new Date().toISOString();
}

export function formatLocalDateTime(value?: string): string {
  if (!value) {
    return "从未同步";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

export function formatConflictFolderName(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-")
    + " "
    + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("-");
}

export function formatRevisionFileName(revision: number, encrypted: boolean): string {
  const base = revision.toString().padStart(6, "0");
  return `history/${base}.json${encrypted ? ".enc" : ""}`;
}
