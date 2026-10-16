/**
 * The "Privacy on rows" view on the Search tab (`./PrivacyRowsView`) as data:
 * the three settings and what each one means, the check's words for each
 * workspace, and which of the switch's buttons is offered. Pure, so the rules
 * are pinned by `adminPrivacyRows.test.ts`.
 *
 * The report is `api.functions.privacyRows.report` (`apps/convex/functions/
 * privacyRows.ts`); its shape is typed here, as `./noteIds` does, so this file
 * reads the same whichever way the generated api is built.
 */

export type AccessSource = "file" | "shadow" | "rows";

export type CheckState = "unchecked" | "running" | "stale" | "differs" | "clean";

export type PrivacyRowsRow = {
  workspaceId: string;
  /** The slug without the `@`, or null when the workspace has none. */
  slug: string | null;
  archived: boolean;
  status: CheckState;
  checked: number;
  differences: number;
  /** Rules that name nothing in the tree. Shown; they do not block the switch. */
  orphans: number;
  /** When the last finished check ran; null until one has. */
  checkedAt: number | null;
};

export type PrivacyRowsReport = {
  source: AccessSource;
  truncated: boolean;
  ready: { ok: boolean; reason: string | null };
  rows: PrivacyRowsRow[];
};

const count = (value: number) => value.toLocaleString("en-US");

/** The setting's word: Off, Shadow or On. */
export function settingLabel(source: AccessSource): string {
  if (source === "shadow") return "Shadow";
  return source === "rows" ? "On" : "Off";
}

/** What the setting means, in plain words. */
export function settingNote(source: AccessSource): string {
  if (source === "shadow") return "Rows are kept up to date with the rules, but nothing reads them yet.";
  if (source === "rows") return "Rows decide who sees what.";
  return "The rules decide who sees what. Rows are not kept.";
}

/** A row's check, in words. */
export function statusLabel(status: CheckState): string {
  switch (status) {
    case "unchecked":
      return "Not checked yet";
    case "running":
      return "Checking";
    case "stale":
      return "Changed since the check. Check again";
    case "differs":
      return "Differs from the rules";
    case "clean":
      return "Matches the rules";
  }
}

/** `@slug`, or `(no handle)`. A leading `@` in the stored value is not doubled. */
export function slugLabel(slug: string | null): string {
  const bare = slug?.replace(/^@+/, "").trim() ?? "";
  return bare === "" ? "(no handle)" : `@${bare}`;
}

/** `Checked 1,204 rows` once a check has counted any; `Not checked yet` before one. */
export function checkedLine(row: PrivacyRowsRow): string {
  return row.checkedAt === null && row.checked === 0 ? "Not checked yet" : `Checked ${count(row.checked)} rows`;
}

/** The count of differences, as the table shows it. */
export function differencesLine(row: PrivacyRowsRow): string {
  return count(row.differences);
}

/** `1 rule names nothing in the tree` and its plural; the table shows the bare number. */
export function orphanNote(orphans: number): string | null {
  if (orphans === 0) return null;
  return `${count(orphans)} ${orphans === 1 ? "rule names" : "rules name"} nothing in the tree`;
}

/** When a check finished, or `Never`. */
export function checkedAtLabel(at: number | null): string {
  if (at === null) return "Never";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The summary above the table: how many workspaces match, differ, or have no current check. */
export function summaryLine(rows: readonly PrivacyRowsRow[]): string {
  if (rows.length === 0) return "No workspaces yet";
  const clean = rows.filter((row) => row.status === "clean").length;
  const differs = rows.filter((row) => row.status === "differs").length;
  const waiting = rows.length - clean - differs;
  const noun = rows.length === 1 ? "workspace" : "workspaces";
  return `${count(rows.length)} ${noun} · ${count(clean)} match · ${count(differs)} differ · ${count(waiting)} need a check`;
}

/** The three buttons, and which of them the card shows and enables. */
export type SwitchButtons = {
  start: { label: string };
  check: { label: string };
  /** Use rows is shown only while the readers are not on rows yet. */
  useRows: { shown: boolean; enabled: boolean; reason: string | null };
  /** Back to Off is always enabled, unless it is already Off. */
  off: { shown: boolean; label: string };
};

export function switchButtons(report: Pick<PrivacyRowsReport, "source" | "ready">): SwitchButtons {
  const onRows = report.source === "rows";
  return {
    start: { label: "Start keeping rows" },
    check: { label: "Check every workspace" },
    useRows: {
      shown: !onRows,
      enabled: report.ready.ok,
      reason: report.ready.ok ? null : report.ready.reason,
    },
    off: { shown: report.source !== "file", label: "Back to Off" },
  };
}

/** The confirm before Use rows, in plain words: what is true after it. */
export function rowsSwitchNote(): string {
  return "After this, readers judge by the access rows. The rules are still kept and can be switched back at any time with Back to Off.";
}

/** The confirm before Back to Off, in plain words. */
export function offNote(): string {
  return "The rules decide who sees what again. The rows are kept, but nothing reads them until you switch on again.";
}

/** The line the card says after a switch, once it has been made. */
export function switchedWords(source: AccessSource): string {
  if (source === "rows") return "Rows decide who sees what now.";
  if (source === "shadow") return "Keeping rows. Nothing reads them yet.";
  return "Off. The rules decide who sees what.";
}
