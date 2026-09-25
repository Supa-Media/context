import type { ConsoleStorage } from "../types";
import { providerLabel } from "../storage/pill";
import { connectionRows, toolsLive, type GrantFacts } from "../../onboarding/tools";

/**
 * "Set up @you · n of 4" — the canvas's widget (A-05, W-07), as rules.
 *
 * The first run ends at the fork now (`onboarding/flow.ts`); everything after
 * it is these four rows, in the console, in any order. Pure so each row's
 * state is a test rather than something found by clicking.
 *
 * **Every "done" is read from a fact, never from a click.** Storage is done
 * when the binding verified, notes when the bucket has notes or a layout we
 * wrote, tools when a client has actually called. A row the person skipped is
 * not done — it is just a row they have not done yet, and it says so.
 */

export type SetupRowKey = "handle" | "storage" | "notes" | "tools";

export type SetupRowState = "done" | "current" | "todo";

export interface SetupRow {
  key: SetupRowKey;
  title: string;
  sub: string;
  state: SetupRowState;
}

export interface ToolRow {
  key: "claude-desktop" | "chatgpt";
  name: string;
  status: "verified" | "waiting" | "not-started";
  sub: string;
}

export interface SetupView {
  rows: SetupRow[];
  done: number;
  total: number;
  complete: boolean;
  tools: ToolRow[];
}

function storageDone(storage: ConsoleStorage | null | undefined): boolean {
  return storage?.status === "connected";
}

function storageSub(slug: string, storage: ConsoleStorage | null | undefined): string {
  if (storage === undefined) return "Checking…";
  if (storage === null) return "Not connected yet";
  if (storage.status === "error") return "Needs attention — we could not reach it";
  if (storage.status !== "connected") return "Being checked";
  if (storage.managed === true) return `Our bucket · @${slug}`;
  return storage.bucket
    ? `${providerLabel(storage.provider)} · ${storage.bucket}`
    : providerLabel(storage.provider);
}

/**
 * Notes are done when there is something to read: counted notes, or a layout
 * we wrote (`created`), or a bucket that already held a context. An empty,
 * verified bucket is not done — the workspace's own band offers it a layout.
 */
function notesDone(storage: ConsoleStorage | null | undefined): boolean {
  if (!storageDone(storage)) return false;
  if ((storage?.noteCount ?? 0) > 0) return true;
  return storage?.scaffoldReason === "created" || storage?.scaffoldReason === "existing-context";
}

function notesSub(storage: ConsoleStorage | null | undefined): string {
  if (!storageDone(storage)) return "Needs storage first";
  const count = storage?.noteCount;
  if (typeof count === "number" && count > 0) {
    const shown = count.toLocaleString("en-US") + (storage?.noteCountTruncated ? "+" : "");
    return count === 1 ? "1 note" : `${shown} notes`;
  }
  if (storage?.scaffoldReason === "created") return "Five folders, ready for your first note";
  if (storage?.scaffoldReason === "existing-context") return "Your existing notes";
  return "Empty — add a starting layout from your workspace";
}

const TOOL_NAMES: Record<ToolRow["key"], string> = {
  "claude-desktop": "Claude Desktop",
  chatgpt: "ChatGPT",
};

function toolRows(grants: readonly GrantFacts[] | undefined): ToolRow[] {
  const rows = connectionRows(grants);
  return (["claude-desktop", "chatgpt"] as const).map((key) => {
    const status = rows.find((row) => row.key === key)?.status ?? "not-connected";
    if (status === "connected") return { key, name: TOOL_NAMES[key], status: "verified", sub: "Verified — it has read your context" };
    if (status === "connecting") return { key, name: TOOL_NAMES[key], status: "waiting", sub: "Signed in · waiting for its first call" };
    return { key, name: TOOL_NAMES[key], status: "not-started", sub: "Not started" };
  });
}

export function setupView({
  slug,
  storage,
  grants,
}: {
  slug: string;
  storage: ConsoleStorage | null | undefined;
  /** `undefined` while the grants list is loading. */
  grants: readonly GrantFacts[] | undefined;
}): SetupView {
  const tools = toolRows(grants);
  const verified = tools.filter((tool) => tool.status === "verified").length;
  const facts: Array<Omit<SetupRow, "state"> & { done: boolean }> = [
    { key: "handle", title: "Your handle", sub: `@${slug} · claimed`, done: true },
    { key: "storage", title: "Your storage", sub: storageSub(slug, storage), done: storageDone(storage) },
    { key: "notes", title: "Your notes", sub: notesSub(storage), done: notesDone(storage) },
    {
      key: "tools",
      title: "Your tools",
      sub:
        grants === undefined
          ? "Checking…"
          : toolsLive(grants)
            ? verified > 0
              ? `${verified} of 2 clients verified · Bootstrap optional`
              : "A tool has read your context · Bootstrap optional"
            : `${verified} of 2 clients verified · Claude & ChatGPT`,
      done: grants !== undefined && toolsLive(grants),
    },
  ];
  // The first row not done is the one to do now; later ones wait their turn.
  const firstOpen = facts.findIndex((row) => !row.done);
  const rows: SetupRow[] = facts.map(({ done, ...row }, index) => ({
    ...row,
    state: done ? "done" : index === firstOpen ? "current" : "todo",
  }));
  const done = facts.filter((row) => row.done).length;
  return { rows, done, total: facts.length, complete: done === facts.length, tools };
}

/**
 * Whether the widget belongs on this screen at all.
 *
 * The owner of a *personal* workspace, because setting it up is theirs to do:
 * a member of somebody else's workspace has the shared welcome instead
 * (`sharedWelcome.ts`), and a shared workspace's owner set it up from
 * `/workspace/new`. Pointer widths only — on a phone the workspace's own band
 * carries the same offers inline. Never on the landing page's demo.
 */
export function showSetupWidget({
  demo,
  compact,
  kind,
  role,
  retired,
}: {
  demo: boolean;
  compact: boolean;
  kind: string | undefined;
  role: string | undefined;
  /** Put away on this device — see `useSetupWidget`. `undefined` while asked. */
  retired: boolean | undefined;
}): boolean {
  if (demo || compact) return false;
  if (kind !== "personal" || role !== "owner") return false;
  return retired === false;
}
