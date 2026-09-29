/**
 * Managed-storage encryption, as the staff console's Estate tab draws it.
 *
 * Every word the card says is decided here, from `rolloutStatus` and nothing
 * else, so the card itself only lays out what this returns and the copy can be
 * tested without a renderer. The wording is the approved artboard's
 * (`Managed storage encryption`, Boards 1 to 3).
 *
 * Two figures on the artboard are deliberately absent: files per second and
 * the added read time. Nothing measures either yet, and a figure nobody
 * measured is a figure this console does not draw.
 */

import { formatCount, type CompositionPart } from "./report";

export type RolloutState = "off" | "running" | "paused" | "failed" | "complete";
export type RolloutScope = "ours" | "picked" | "all";
export type WorkspaceEncryptionState = "waiting" | "encrypting" | "checking" | "encrypted" | "failed";

export interface RolloutWorkspace {
  workspaceId: string;
  slug: string;
  state: WorkspaceEncryptionState;
  filesDone: number;
  filesTotal?: number;
  errorCode?: string;
  updatedAt: number;
}

/** What `managedEncryption.rolloutStatus` returns. */
export interface RolloutStatus {
  state: RolloutState;
  scope?: RolloutScope;
  acceptsNew?: boolean;
  startedBy?: string;
  startedAt?: number;
  changedBy?: string;
  pauseReason?: string;
  updatedAt?: number;
  managedTotal: number;
  counts: {
    waiting: number;
    encrypting: number;
    checking: number;
    encrypted: number;
    failed: number;
    notStarted: number;
  };
  files: { done: number; total: number };
  workspaces: RolloutWorkspace[];
}

export interface RolloutCandidate {
  workspaceId: string;
  slug: string;
  ours: boolean;
}

export type PillTone = "ok" | "warn" | "crit" | "neutral";

/** What the card does next, by button. */
export type CardAction = "start" | "pause" | "resume" | "resumeOthers" | "stopNew";

export interface EncryptionCardView {
  /** Which of the artboard's states this is; the tests read it. */
  kind: "empty" | "off" | "offSomeDone" | "running" | "paused" | "failed" | "complete";
  pill: { label: string; tone: PillTone };
  /** The sentence under the title. Absent while running: the bar says it. */
  summary?: string;
  /** Who did it and when, in the quiet voice. */
  byline?: string;
  /** The bar, while there is progress to show. */
  bar?: CompositionPart[];
  /** `14 managed workspaces` and `31,480 of 41,300 files done`. */
  figures?: string[];
  /** The one button this state offers. */
  action: CardAction;
  /** The failed workspaces, each with its own Retry. */
  failed: RolloutWorkspace[];
  /** Whether the full workspaces table is drawn under the card. */
  table: boolean;
}

export const CARD_TITLE = "Managed storage encryption";
export const LOAD_FAILED = "Couldn't load the rollout. Workspaces carry on as they were.";

export const ACTION_LABELS: Record<CardAction, string> = {
  start: "Start encrypting…",
  pause: "Pause",
  resume: "Resume",
  resumeOthers: "Resume the others",
  stopNew: "Stop starting new workspaces…",
};

const SCOPE_LABELS: Record<RolloutScope, string> = {
  ours: "Our own workspaces",
  picked: "Picked workspaces",
  all: "Every managed workspace",
};

function workspaces(count: number): string {
  return `${formatCount(count)} workspace${count === 1 ? "" : "s"}`;
}

function exact(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

function managed(count: number): string {
  return `${formatCount(count)} managed workspace${count === 1 ? "" : "s"}`;
}

/** `today 09:12`, or `4 Sep 09:12` on another day. Local time: staff read it. */
export function clockLabel(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  if (sameDay) return `today ${time}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${when.getDate()} ${months[when.getMonth()]} ${time}`;
}

function by(verb: string, who: string | undefined, at: number | undefined, now: number): string | undefined {
  if (who === undefined && at === undefined) return undefined;
  const parts = [verb];
  if (who !== undefined && who !== "system") parts.push(`by ${who}`);
  const head = parts.join(" ");
  return at === undefined ? head : `${head}, ${clockLabel(at, now)}`;
}

function barOf(status: RolloutStatus): CompositionPart[] {
  const c = status.counts;
  return [
    { key: "encrypted", label: "encrypted", count: c.encrypted, tone: "ok" },
    { key: "active", label: "encrypting or checking", count: c.encrypting + c.checking, tone: "accent" },
    { key: "waiting", label: "waiting", count: c.waiting, tone: "muted" },
    { key: "failed", label: "need attention", count: c.failed, tone: "crit" },
  ];
}

function figuresOf(status: RolloutStatus): string[] {
  return [
    managed(status.managedTotal),
    // Exact: this is a sentence with room, not a tile.
    `${exact(status.files.done)} of ${exact(status.files.total)} files done`,
  ];
}

/** The rollout, as the card says it. Pure: `now` only dates the byline. */
export function encryptionCardView(status: RolloutStatus, now: number = Date.now()): EncryptionCardView {
  const c = status.counts;
  const failed = status.workspaces.filter((workspace) => workspace.state === "failed");
  const base = { failed: [] as RolloutWorkspace[], table: false };

  switch (status.state) {
    case "running": {
      const scope = status.scope === undefined ? undefined : SCOPE_LABELS[status.scope];
      const started = by("Started", status.startedBy, status.startedAt, now);
      return {
        ...base,
        kind: "running",
        pill: { label: "Running", tone: "neutral" },
        bar: barOf(status),
        figures: figuresOf(status),
        byline: [started, scope].filter((part): part is string => part !== undefined).join(" · ") || undefined,
        action: "pause",
        table: true,
      };
    }
    case "paused": {
      const partway = c.encrypting + c.checking;
      const who = by("Paused", status.changedBy, status.updatedAt, now);
      return {
        ...base,
        kind: "paused",
        pill: { label: "Paused", tone: "warn" },
        summary:
          `${formatCount(c.encrypted)} encrypted, ${formatCount(partway)} stopped partway, ` +
          `${formatCount(c.waiting)} waiting. Everything still opens. Saves to encrypted workspaces stay encrypted.`,
        byline:
          who === undefined
            ? undefined
            : status.pauseReason
              ? `${who}: "${status.pauseReason}"`
              : who,
        figures: figuresOf(status),
        action: "resume",
        table: true,
      };
    }
    case "failed": {
      const count = Math.max(c.failed, failed.length);
      const one = count === 1;
      return {
        ...base,
        kind: "failed",
        pill: { label: "Failed check", tone: "crit" },
        summary:
          `${workspaces(count)} failed ${one ? "its" : "their"} check, so the rollout paused itself. ` +
          `${one ? "Its" : "Their"} files still open. Nothing has been deleted.`,
        figures: figuresOf(status),
        action: "resumeOthers",
        failed,
        table: true,
      };
    }
    case "complete": {
      const all = c.notStarted === 0 && c.encrypted === status.managedTotal;
      const head = all
        ? status.managedTotal === 1
          ? "The 1 managed workspace is encrypted and checked."
          : `All ${managed(status.managedTotal)} are encrypted and checked.`
        : `${formatCount(c.encrypted)} of ${managed(status.managedTotal)} are encrypted and checked.`;
      const tail = status.acceptsNew ? " New managed workspaces are encrypted from their first file." : "";
      const finished = status.updatedAt === undefined ? undefined : `Finished ${clockLabel(status.updatedAt, now)}`;
      return {
        ...base,
        kind: "complete",
        pill: { label: "Complete", tone: "ok" },
        summary: head + tail,
        byline: finished,
        // Stopping only means something while new workspaces are being taken
        // on. A rollout that covered only some can be widened instead.
        action: status.acceptsNew ? "stopNew" : "start",
        table: true,
      };
    }
    case "off":
    default: {
      if (status.managedTotal === 0) {
        return {
          ...base,
          kind: "empty",
          pill: { label: "Off", tone: "neutral" },
          summary: "No managed workspaces yet. New ones will be encrypted from their first file once this is on.",
          action: "start",
        };
      }
      const touched = c.encrypted + c.encrypting + c.checking + c.failed;
      if (touched === 0) {
        return {
          ...base,
          kind: "off",
          pill: { label: "Off", tone: "neutral" },
          summary: `${managed(status.managedTotal)} store plain files. Customer-owned buckets are never touched.`,
          action: "start",
        };
      }
      const finishing = c.encrypting + c.checking;
      const notStarted = c.notStarted + c.waiting;
      const parts = [
        `${workspaces(c.encrypted)} stay${c.encrypted === 1 ? "s" : ""} encrypted.`,
        ...(finishing > 0 ? [`${formatCount(finishing)} still finishing.`] : []),
        `${formatCount(notStarted)} ${notStarted === 1 ? "isn't" : "aren't"} started.`,
      ];
      return {
        ...base,
        kind: "offSomeDone",
        pill: { label: "Off", tone: "neutral" },
        summary: parts.join(" "),
        byline: by("Turned off", status.changedBy, status.updatedAt, now),
        action: "start",
        failed,
        table: true,
      };
    }
  }
}

/** A workspace's state, as its pill says it. */
export function workspaceStatePill(state: WorkspaceEncryptionState): { label: string; tone: PillTone } {
  switch (state) {
    case "encrypted":
      return { label: "Encrypted", tone: "ok" };
    case "encrypting":
      return { label: "Encrypting", tone: "neutral" };
    case "checking":
      return { label: "Checking", tone: "neutral" };
    case "failed":
      return { label: "Failed check", tone: "crit" };
    case "waiting":
    default:
      return { label: "Waiting", tone: "neutral" };
  }
}

/** `1,240 / 3,112`, `9,604` once encrypted, `— / 2,050` before anything is done. */
export function workspaceFiles(workspace: RolloutWorkspace): string {
  const total = workspace.filesTotal === undefined ? "—" : formatCount(workspace.filesTotal);
  if (workspace.state === "encrypted") {
    return formatCount(workspace.filesTotal ?? workspace.filesDone);
  }
  if (workspace.state === "waiting" && workspace.filesDone === 0) return `— / ${total}`;
  return `${formatCount(workspace.filesDone)} / ${total}`;
}

/**
 * Why a workspace stopped, in words. The code is content-free by construction
 * (`managedEncryptionFns/walk.ts`), so the unknown one is shown as it is.
 */
export function failureLine(code: string | undefined): string {
  switch (code) {
    case "KEY_UNAVAILABLE":
      return "Its key couldn't be opened";
    case "WALK_FAILED":
    case undefined:
      return "Stopped on an error";
    default:
      return `Stopped on ${code}`;
  }
}

// -- starting -------------------------------------------------------------

export interface ScopeOption {
  value: RolloutScope;
  label: string;
  detail: string;
}

/** Board 3's three choices, with the counts they name. */
export function scopeOptions(candidates: readonly RolloutCandidate[]): ScopeOption[] {
  const ours = candidates.filter((candidate) => candidate.ours);
  const shown = ours.slice(0, 3).map((candidate) => `@${candidate.slug}`);
  const more = ours.length > shown.length ? ` and ${formatCount(ours.length - shown.length)} more` : "";
  const oursDetail =
    ours.length === 0
      ? "None of ours are on managed storage"
      : `${shown.join(", ")}${more} · ${workspaces(ours.length)}`;
  return [
    { value: "ours", label: "Our own workspaces first", detail: oursDetail },
    {
      value: "picked",
      label: "Workspaces I pick",
      detail: `Choose from the ${formatCount(candidates.length)} managed workspace${candidates.length === 1 ? "" : "s"}`,
    },
    {
      value: "all",
      label: "Every managed workspace",
      detail: `${formatCount(candidates.length)} now, plus every new one`,
    },
  ];
}

/** How many a start would take on. */
export function startCount(
  scope: RolloutScope,
  candidates: readonly RolloutCandidate[],
  picked: ReadonlySet<string>,
): number {
  if (scope === "ours") return candidates.filter((candidate) => candidate.ours).length;
  if (scope === "picked") return candidates.filter((candidate) => picked.has(candidate.workspaceId)).length;
  return candidates.length;
}

/**
 * The primary button says how many: "Start with 3", never just "Start". The
 * one exception is every workspace when there are none yet, which still means
 * something: each new one is encrypted from its first file.
 */
export function startLabel(scope: RolloutScope, count: number): string {
  if (scope === "all" && count === 0) return "Start";
  return `Start with ${formatCount(count)}`;
}

/** Whether Start may be pressed. */
export function canStart(scope: RolloutScope, count: number): boolean {
  return scope === "all" || count > 0;
}
