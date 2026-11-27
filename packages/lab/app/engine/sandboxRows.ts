/**
 * The test chat's rows and writes as the gateway sends them (`POST /tex-lab/sandbox`, `labSandbox/route.js`), read into
 * the Lab's shapes: each row with what its steps gave, and each write with only the fields it sent. Kept apart from the
 * test chat's state and calls (`sandbox.ts`), which re-exports them.
 */
import type { StepCell } from "../views/grid/TextGrid.web";
import type { Screen } from "@context/tex/src/texSets.d.cts";
import { screenProblems } from "@context/lab/src/texScreen.cjs";
import { stepExtra, type StepExtra } from "./stepRun";

/** A step as the grid shows it (`out` in words) with the contract's optional fields (`stepRun.ts`), as the gateway sent them. */
export type SandboxStep = StepCell & StepExtra;

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What an in-app test text says the app had open, when it is one the app could send; else none. */
export const screenOf = (v: unknown): Screen | undefined => (v && typeof v === "object" && screenProblems(v).length === 0 ? (v as Screen) : undefined);

export type SandboxRow = {
  id: string;
  who: string;
  text: string;
  at?: number;
  prod?: boolean;
  quiet?: boolean;
  tex?: boolean;
  steps?: SandboxStep[];
  /** A reply row: the text it answers (its steps are shown on that text's row). */
  reply?: string;
  /** Tex's row: the ids of the steps that led to it, in run order, as the gateway logged them (never inferred). */
  cause?: string[];
  /** Tex's row: the step that sent it ("fd" the turn's answer, "job" a background job's text...). */
  from?: string;
  /** Pictures sent with the text (https only), the text it replies to, whether it was edited, and taken back (unsent). */
  pics?: string[];
  replyTo?: string;
  edited?: boolean;
  unsent?: boolean;
  /** The text a tapback, an edit or an unsend row is on. */
  on?: string;
  /** Tapbacks on this text, each run as a Tex turn of its own. */
  reactions?: Array<{ who: string; emoji: string }>;
  /** A row that is a tapback, an edit or an unsend on another text, or who is in a made-up chat changing ("people"). */
  kind?: "reaction" | "edit" | "unsend" | "people";
  /** A made-up chat: a reply's `group` (what the preview's control plane said), a people row's change and name, and a card a row carries. */
  group?: unknown;
  change?: "added" | "left";
  name?: string;
  media?: Record<string, unknown>;
  /** An in-app test chat's text: what the app had open as it went (`texScreen.cjs`). */
  screen?: Screen;
};
/** The tapbacks iMessage has, in its order. */
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
/**
 * One thing a test turn wrote (the gateway's `writes`): its kind and the line that says it, and, where it has them, the
 * contract's fields to open it with: a page's address (read back with op `page`), an email's `to`/`subject`/`body`, a
 * note's `body`.
 */
export type SandboxWrite = { kind: string; summary: string; by?: string; id?: string; title?: string; body?: string; url?: string; to?: string; subject?: string; expires?: number };

/** One row of the gateway's answer, with what each step gave. */
export function rowOf(r: Record<string, unknown>): SandboxRow {
  const who = str(r.who);
  return {
    id: str(r.id),
    who,
    text: str(r.text),
    at: num(r.at) ?? undefined,
    prod: r.prod === true,
    quiet: r.quiet === true,
    tex: who === "Tex" || r.tex === true,
    steps: arr<Record<string, unknown>>(r.steps).map((x) => ({ node: str(x.node), out: typeof x.out === "string" || x.out === undefined || x.out === null ? str(x.out) : JSON.stringify(x.out), ms: num(x.ms), ok: x.ok === false ? false : true, ...stepExtra(x) })),
    ...(typeof r.reply === "string" && r.reply ? { reply: r.reply } : {}),
    ...(Array.isArray(r.cause) ? { cause: arr<unknown>(r.cause).filter((x): x is string => typeof x === "string" && !!x) } : {}),
    ...(typeof r.from === "string" && r.from ? { from: r.from } : {}),
    ...(Array.isArray(r.pics) ? { pics: arr<unknown>(r.pics).map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? str((p as Record<string, unknown>).url) : "")).filter((u) => u.startsWith("https://")) } : {}),
    ...(typeof r.replyTo === "string" && r.replyTo ? { replyTo: r.replyTo } : {}),
    ...(r.edited === true ? { edited: true } : {}),
    ...(r.unsent === true ? { unsent: true } : {}),
    ...(typeof r.on === "string" && r.on ? { on: r.on } : {}),
    ...(Array.isArray(r.reactions) ? { reactions: arr<Record<string, unknown>>(r.reactions).map((x) => ({ who: str(x.who), emoji: str(x.emoji) })).filter((x) => x.emoji) } : {}),
    ...(r.kind === "reaction" || r.kind === "edit" || r.kind === "unsend" || r.kind === "people" ? { kind: r.kind } : {}),
    ...(r.group && typeof r.group === "object" ? { group: r.group } : {}),
    ...(r.change === "added" || r.change === "left" ? { change: r.change, name: str(r.name) } : {}),
    ...(r.media && typeof r.media === "object" && !Array.isArray(r.media) ? { media: r.media as Record<string, unknown> } : {}),
    ...(screenOf(r.screen) ? { screen: screenOf(r.screen) } : {}),
  };
}

/** One of the gateway's writes, with only the fields it sent (text only; a page's address only over https). */
export function writeOf(w: Record<string, unknown>): SandboxWrite {
  const out: SandboxWrite = { kind: str(w.kind), summary: str(w.summary) || str(w.title) };
  for (const k of ["by", "id", "title", "body", "to", "subject"] as const) if (str(w[k])) out[k] = str(w[k]);
  if (str(w.url).startsWith("https://")) out.url = str(w.url);
  if (num(w.expires) !== null) out.expires = num(w.expires)!;
  return out;
}

/** A page's id in the sandbox: the last segment of its address (an id, never a name shown), else the write's own id. */
const lastSegment = (url: string) => {
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1);
};
export const pageIdOf = (w: SandboxWrite) => (w.url ? lastSegment(w.url) : "") || w.id || "";
