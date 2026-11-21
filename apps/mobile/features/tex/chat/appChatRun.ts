/**
 * The words and numbers of a Tex run card and of a person's delivery line.
 *
 * Pure: no React, no clock. The card reads a run and a `now` it is given, and
 * every string it shows is built here, so the mock's wording is pinned in one
 * place and tested without a renderer. Words only: nothing here builds markup.
 */

export type LiveStep = {
  k: "think" | "tool";
  at: number;
  text?: string;
  name?: string;
  what?: string;
  ok?: boolean;
  ms?: number;
  res?: string;
  held?: boolean;
};

export type RunCardData = {
  turn?: string;
  live: boolean;
  startedAt?: number;
  now?: string;
  secs?: number;
  steps: LiveStep[];
};

export type DeliveryState = "sending" | "sent" | "reading" | "read" | "answered" | "failed" | "stopped" | "queued";

export type StepIcon = "brain" | "search" | "read" | "write" | "mail" | "web" | "calendar" | "chat" | "hist" | "tool";

export type RunHead =
  | { live: true; label: string; elapsed: number }
  | { live: false; label: string; steps: string };

export const TRY_AGAIN = "Try again";
export const QUEUED_SENTENCE = "Tex reads this as soon as it finishes the step it's on";
export const STOPPED_TOAST = "Stopped. Tex keeps what it already did.";

/** The tokens of a tool name: `search_email` → ["search", "email"]. */
function tokensOf(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/** Whether a token starts with one of the stems: `searched` matches `search`. */
function hasStem(tokens: string[], stems: string[]): boolean {
  return tokens.some((t) => stems.some((s) => t.startsWith(s)));
}

const MAIL_STEMS = ["email", "mail", "gmail"];
const READ_STEMS = ["read", "fetch", "list", "open"];
const WRITE_STEMS = ["write", "save", "edit", "update", "remember"];

export function stepIcon(step: LiveStep): StepIcon {
  if (step.k === "think") return "brain";
  const name = step.name ?? "";
  const tokens = tokensOf(name);
  if (hasStem(tokens, ["search"])) {
    return hasStem(tokens, MAIL_STEMS) ? "mail" : "search";
  }
  if (hasStem(tokens, MAIL_STEMS)) return "mail";
  if (hasStem(tokens, READ_STEMS)) return "read";
  if (hasStem(tokens, WRITE_STEMS)) return "write";
  if (hasStem(tokens, ["web", "browse", "page", "url"])) return "web";
  if (hasStem(tokens, ["calendar"])) return "calendar";
  if (tokens.includes("chat") || tokens.includes("text")) return "chat";
  if (hasStem(tokens, ["job", "background"])) return "hist";
  return "tool";
}

/**
 * A path keeps its last two segments: `areas/bible-study/Daniel 6.md` reads as
 * `bible-study/Daniel 6.md`, and a bare name is left as it is.
 */
function trimPath(what: string): string {
  const parts = what.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/") || what;
}

/** The past tense of each read or write verb, checked in this order. */
const PAST_VERBS: Array<[string, string]> = [
  ["read", "Read"],
  ["fetch", "Fetched"],
  ["list", "Listed"],
  ["open", "Opened"],
  ["write", "Wrote"],
  ["save", "Saved"],
  ["edit", "Edited"],
  ["update", "Updated"],
  ["remember", "Remembered"],
];

/** The past-tense verb for a read or write tool, or null when neither. */
function pastVerb(name: string): string | null {
  const tokens = tokensOf(name);
  for (const [stem, past] of PAST_VERBS) {
    if (hasStem(tokens, [stem])) return past;
  }
  return null;
}

/** A short past-tense line for a step, in words. */
export function stepWords(step: LiveStep): string {
  if (step.k === "think") return step.text ?? "";
  const name = step.name ?? "";
  const icon = stepIcon(step);
  const what = step.what ? step.what : "";
  const quoted = (value: string) => `“${value}”`;
  const tokens = tokensOf(name);

  if (hasStem(tokens, ["search"])) {
    // The noun is what was searched: `search_notes` → "notes". Mail is named
    // as mail whatever the tool calls it.
    const noun = icon === "mail" ? "mail" : tokens.filter((t) => !t.startsWith("search")).join(" ");
    return ["Searched", noun, what ? quoted(what) : ""].filter(Boolean).join(" ");
  }

  const verb = pastVerb(name);
  if (verb !== null) {
    const shown = what ? quoted(trimPath(what)) : "";
    return [verb, shown].filter(Boolean).join(" ");
  }

  const base = `Ran ${name || "tool"}`;
  return what ? `${base} ${quoted(what)}` : base;
}

/** The number of tool steps; thinking does not count. */
export function stepCount(steps: LiveStep[]): number {
  return steps.filter((s) => s.k === "tool").length;
}

/** The header of a run card: the live label and elapsed, or the settled summary. */
export function runHead(run: RunCardData, nowMs: number): RunHead {
  if (run.live) {
    const lastTool = [...run.steps].reverse().find((s) => s.k === "tool");
    const label = run.now ?? (lastTool ? stepWords(lastTool) : "");
    const elapsed = run.startedAt === undefined ? 0 : Math.max(0, Math.round((nowMs - run.startedAt) / 1000));
    return { live: true, label: label || "Thinking", elapsed };
  }
  const n = stepCount(run.steps);
  return {
    live: false,
    label: `Worked ${run.secs ?? 0}s`,
    steps: `${n} ${n === 1 ? "step" : "steps"}`,
  };
}

/**
 * A duration in one decimal under ten seconds (`0.4s`), whole seconds above.
 * The switch happens where the tenths would round up to ten, so `9.96s` never
 * reads `10.0s`.
 */
export function secsLabel(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** The word after the time on a person's line; empty when there is none. */
export function deliveryWord(state: DeliveryState): string {
  switch (state) {
    case "sending":
      return "Sending…";
    case "sent":
      return "Delivered";
    case "reading":
      return "Read";
    case "read":
      return "Read";
    case "answered":
      return "Answered";
    case "stopped":
      return "Stopped";
    case "queued":
      return "Delivered";
    case "failed":
      return "";
  }
}

export function failedSentence(atLabel: string): string {
  return `Tex didn't answer this. It hit an error at ${atLabel}.`;
}
