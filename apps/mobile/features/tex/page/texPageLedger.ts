/**
 * The chat's history file on the Tex page: reading the gateway's answers
 * field by field, and the one line each entry shows before it is opened.
 * The entry itself is always shown as kept, raw (decided by the owner,
 * 2026-11-02: "show the raw JSON ledger, and then some nice custom UI to
 * filter it"; `docs/decisions/texting-assistant/chat-ledger.md`).
 */

import type { LedgerEntry, LedgerManifest, LedgerPage, LedgerSees } from "./texPageTypes";

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function readManifest(v: unknown): LedgerManifest | null {
  const m = record(v);
  if (m === null) return null;
  return { schema: str(m.schema), version: num(m.version) ?? 0, count: num(m.count) ?? 0, created: num(m.created), updated: num(m.updated) };
}

function readEntry(v: unknown): LedgerEntry | null {
  const e = record(v);
  if (e === null || typeof e.id !== "string" || typeof e.kind !== "string" || num(e.at) === null) return null;
  return e as LedgerEntry;
}

export function readLedgerPage(body: unknown): LedgerPage | null {
  const b = record(body);
  if (b === null) return null;
  const entries = Array.isArray(b.entries) ? b.entries.map(readEntry).filter((e): e is LedgerEntry => e !== null) : [];
  const older = num(b.before);
  return { manifest: readManifest(b.manifest), entries, ...(older !== null ? { older } : {}) };
}

export function readLedgerSees(body: unknown): LedgerSees | null {
  const b = record(body);
  if (b === null || typeof b.text !== "string") return null;
  const settings: LedgerSees["settings"] = {};
  for (const [k, v] of Object.entries(record(b.settings) ?? {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") settings[k] = v;
  }
  return { settings, text: b.text };
}

/** A day the gateway takes, or "" for every day; anything else is not sent. */
export const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/;

const words = (v: unknown, most = 90): string => {
  const s = str(v).replace(/\s+/g, " ").trim();
  return s.length > most ? `${s.slice(0, most - 1)}…` : s;
};

/** Who wrote a text entry. */
function fromOf(e: LedgerEntry): string {
  const from = record(e.from);
  const kind = str(from?.kind);
  if (kind === "tex") return "Tex";
  if (kind === "system") return "System";
  return str(from?.name) || "Person";
}

/** The entry's one line: who or what, and its first words. Never more than the entry holds. */
export function entryLine(e: LedgerEntry): string {
  switch (e.kind) {
    case "text":
      return `${fromOf(e)}: ${words(e.text)}`;
    case "thinking":
    case "said":
    case "note":
      return words(e.text);
    case "tool": {
      const how = e.withheld ? "result withheld (another workspace)" : e.held ? "held" : e.ok === false ? "failed" : "ok";
      return `${str(e.name) || "tool"} · ${how}${num(e.ms) !== null ? ` · ${e.ms} ms` : ""}`;
    }
    case "reply":
      return `Answer${e.clean === true ? " · clean" : ""}${e.text ? `: ${words(e.text)}` : ""}`;
    case "advisor":
      return `Asked: ${words(e.question)}`;
    case "mail_check":
      return `${str(e.verdict) || "checked"} · to ${words(e.to, 40)}`;
    case "job":
      return `${words(e.title, 60) || str(e.job)} · ${str(e.state)}`;
    default:
      return e.kind;
  }
}

/** The kind as the filter names it. */
export const KIND_LABEL: Record<string, string> = {
  text: "Texts",
  thinking: "Thinking",
  said: "Said between tools",
  tool: "Tools",
  reply: "Answers",
  advisor: "Advisor",
  mail_check: "Email checks",
  job: "Jobs",
  note: "Notes",
};

/** A setting of "what Tex sees", in words. */
export const SETTING_LABEL: Record<string, string> = {
  thinking: "Shown its own thinking",
  toolNames: "Shown which tools it used",
  toolResults: "Shown tool results",
  budgetChars: "Characters of chat it reads",
  lastDayFrom: "Last day comes from",
  before: "Before that, from",
};

export function settingValue(v: string | number | boolean): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return typeof v === "number" ? v.toLocaleString("en-US") : v;
}
