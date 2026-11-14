/**
 * "You" as the Lab's test user (Dev2, 2026-11-13: "give me the ability to change the user to my user, and essentially
 * replay old messages ... it also should probably be read only").
 *
 * The Lab reads the signed-in person's own one-to-one chat ledger through the Tex page's history route
 * (`POST /tex/page/ledger`, which answers only a person's own chat), finds each text they sent, what Tex answered and
 * which Tex that was (the reply's `version`, `apps/mcp/src/agent/texVersion.js`), and the notes that turn read. A
 * picked text goes into the version's run config as a replay; `pnpm ai lab replay` (`apps/mcp/bench/labReplay.mjs`)
 * runs it again in a throwaway world, where nothing can text anyone or change a real note, and prints Then beside Now,
 * which `parseReplay` reads back.
 */
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import type { LedgerEntry } from "../../page/texPageTypes";

export type TexVersion = { code?: string; deploy?: string; setup?: string };

/** One text the person sent, with the chat just before it and what Tex said then. */
export type MyText = {
  id: string;
  at: number;
  seq: number;
  text: string;
  earlier: Array<{ from: "person" | "tex"; text: string }>;
  then: { text: string; version: TexVersion | null };
  turn: string | null;
  /** Who sent it in a group chat (the name the chat knows them by); absent in a one-to-one. */
  who?: string;
};

/** What made Tex text without a text from them first (`texConfig.json`'s other start steps). */
export type Start = "checkin" | "routine" | "notify";

/**
 * One line of a chat as the Lab's conversation shows it: every text in order, and the person's ones playable. A text
 * Tex sent on its own (a check-in, a routine's run, another AI's ping) carries `start`, and is playable too: from that
 * start step, with its turn when one ran (`turn`), what it was asked (`about`) and the routine's note (`routine`).
 */
export type ChatLine = {
  id: string;
  at: number;
  from: "person" | "tex";
  who: string;
  text: string;
  play: MyText | null;
  start?: Start;
  turn?: string;
  about?: string;
  routine?: string;
  /** A check-in that looked and sent nothing: no text, only its steps (Dev2, 2026-11-14: "is the check in/routines even wired in at all?"). */
  quiet?: boolean;
};

/** One replayed text, as the pasted "## Lab replay" block gives it. */
export type ReplayNow = { id: string; now: string; failed?: string };

const EARLIER = 6;
const NOTE = /^(?!\/)(?!.*(?:^|\/)\.)(?!.*\/\/)[\w ().,'&+-]+(?:\/[\w ().,'&+-]+)*\.md$/u;
const VERSION_PART = /^[0-9a-f-]{6,64}$/i;
/** The tools whose arguments name one note they read. */
const READS = new Set(["fetch", "read_note", "read", "open_note"]);

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function versionOf(v: unknown): TexVersion | null {
  const r = rec(v);
  if (!r) return null;
  const out: TexVersion = {};
  for (const k of ["code", "deploy", "setup"] as const) if (typeof r[k] === "string" && VERSION_PART.test(r[k] as string)) out[k] = (r[k] as string).toLowerCase();
  return Object.keys(out).length ? out : null;
}

const fromKind = (e: LedgerEntry) => str(rec(e.from)?.kind);

/**
 * The person's texts, newest first, from ledger entries (text and reply kinds, any order). A text is joined to Tex's
 * answer by the answer's `covers` (the texting Worker's event ids) and to the turn's reply by its `turn`.
 */
export function myTexts(entries: LedgerEntry[]): MyText[] {
  const sorted = [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at);
  const texts = sorted.filter((e) => e.kind === "text" && !e.job);
  const replies = new Map<string, LedgerEntry>();
  for (const e of sorted) if (e.kind === "reply" && typeof e.turn === "string") replies.set(e.turn, e);
  // Tex's text that answered each of theirs, by the event id it covers.
  const answeredBy = new Map<string, LedgerEntry>();
  for (const e of texts) {
    if (fromKind(e) !== "tex" || !Array.isArray(e.covers)) continue;
    for (const id of e.covers) if (typeof id === "string" && !answeredBy.has(id)) answeredBy.set(id, e);
  }
  const out: MyText[] = [];
  texts.forEach((e, i) => {
    if (fromKind(e) !== "person" || str(e.text).trim() === "") return;
    const answer = answeredBy.get(str(e.eid)) ?? null;
    const turn = answer && typeof answer.turn === "string" ? answer.turn : null;
    const reply = turn ? replies.get(turn) : undefined;
    const earlier = texts
      .slice(Math.max(0, i - EARLIER), i)
      .filter((x) => fromKind(x) === "person" || fromKind(x) === "tex")
      .map((x) => ({ from: fromKind(x) === "tex" ? ("tex" as const) : ("person" as const), text: str(x.text) }));
    const who = str(rec(e.from)?.name);
    out.push({ id: e.id, at: e.at, seq: e.seq ?? 0, text: str(e.text), earlier, then: { text: str(answer?.text) || str(reply?.text), version: versionOf(reply?.version) }, turn, ...(who ? { who } : {}) });
  });
  return out.reverse();
}

const CHECK_IN = /^\(Not a text from them\. This was your own check-in/;
const PING = /^\(Not a text from them\. Another of their agents asked you to get their attention/;

/** Which start step a `note` entry was, or null for one that is not a text Tex sent on its own. */
export function startOf(e: LedgerEntry): Start | null {
  if (e.kind !== "note" || e.backfill || str(e.text).trim() === "") return null;
  if (str(e.routine)) return "routine";
  const about = str(e.about);
  if (CHECK_IN.test(about)) return "checkin";
  if (PING.test(about)) return "notify";
  return null;
}

/** A routine's name from its note's path: `tex/routines/daily/morning-news.md` is "morning news". */
/** A routine's note, named for display: its leaf without `.md`, contained like every other drawn name. */
export const routineName = (path: string) => isolateForDisplay(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "").replace(/[-_]+/g, " "));

/**
 * The whole chat, oldest first, from the same entries: the person's texts (playable, joined to `myTexts`), Tex's
 * answers, and what Tex texted on its own (a check-in, a routine, a ping: `note` entries), so the Lab can show the
 * conversation and a click on a text plays it. Jobs and system lines are left out.
 */
export function chatLines(entries: LedgerEntry[], texts: MyText[], { group = false } = {}): ChatLine[] {
  const byId = new Map(texts.map((t) => [t.id, t]));
  const lines = textLines(entries, byId, group);
  // A check-in that sent nothing still ran (its steps are logged under its `ck…` turn): a line of its own, so it can be replayed too.
  const said = new Set(lines.map((l) => l.turn).filter(Boolean));
  const looks = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (typeof e.turn === "string" && e.turn.startsWith("ck") && !said.has(e.turn)) looks.set(e.turn, [...(looks.get(e.turn) ?? []), e]);
  const quiet: ChatLine[] = [...looks]
    .map(([turn, es]): ChatLine => ({ id: "ck:" + turn, at: Math.max(...es.map((e) => e.at)), from: "tex", who: "Tex", text: "", play: null, start: "checkin", turn, quiet: true }))
    .sort((a, b) => a.at - b.at);
  // Each goes in where it ran, the chat's own order kept.
  const out: ChatLine[] = [];
  for (const l of lines) {
    while (quiet.length && quiet[0].at <= l.at) out.push(quiet.shift()!);
    out.push(l);
  }
  return [...out, ...quiet];
}

function textLines(entries: LedgerEntry[], byId: Map<string, MyText>, group: boolean): ChatLine[] {
  return [...entries]
    .filter((e) => startOf(e) !== null || (e.kind === "text" && !e.job && (fromKind(e) === "person" || fromKind(e) === "tex") && str(e.text).trim() !== ""))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at)
    .map((e): ChatLine => {
      const start = startOf(e);
      if (start) {
        const turn = str(e.turn);
        const routine = str(e.routine);
        const about = str(e.about);
        return { id: e.id, at: e.at, from: "tex", who: "Tex", text: str(e.text), play: null, start, ...(turn ? { turn } : {}), ...(about ? { about } : {}), ...(routine ? { routine } : {}) };
      }
      const tex = fromKind(e) === "tex";
      const name = str(rec(e.from)?.name);
      return { id: e.id, at: e.at, from: tex ? ("tex" as const) : ("person" as const), who: tex ? "Tex" : group ? name || "Someone" : "You", text: str(e.text), play: tex ? null : (byId.get(e.id) ?? null) };
    });
}

/** The notes one turn's tool calls read by name, from its tool entries. */
export function readsOf(entries: LedgerEntry[], turn: string | null): string[] {
  if (!turn) return [];
  const paths = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "tool" || e.turn !== turn || e.withheld) continue;
    const args = rec(e.args);
    const named = args && READS.has(str(e.name)) ? str(args.id) || str(args.path) : "";
    if (named && !rec(args)?.context && NOTE.test(named)) paths.add(named);
  }
  return [...paths].sort();
}

/** A version stamp in a few characters: the commit and the setup. */
export const shortVersion = (v: TexVersion | null) => (v ? [v.code ? v.code.slice(0, 7) : null, v.setup ? "setup " + v.setup.slice(0, 6) : null].filter(Boolean).join(" · ") || "unknown" : "no version");

/** The replays a run config carries, and who they run as. */
export function replayConfig(picked: MyText[], reads: Record<string, string[]>, as: { handle: string; name: string } | null) {
  if (!as || !picked.length) return {};
  return {
    replayAs: as,
    replays: picked.map((t) => ({ id: t.id, text: t.text, at: t.at, earlier: t.earlier, reads: reads[t.id] ?? [], then: t.then })),
  };
}

/** A pasted "## Lab replay" block, read back: each text's id and what this version said now. */
export function parseReplay(txt: string): ReplayNow[] {
  const at = txt.indexOf("## Lab replay");
  if (at < 0) return [];
  const out: ReplayNow[] = [];
  for (const part of txt.slice(at).split(/\n### /).slice(1)) {
    const id = part.split("\n")[0].trim();
    const m = /\*\*Now:\*\* (.*)/.exec(part);
    if (!id || !m) continue;
    const failed = /^failed \((.*)\)$/.exec(m[1].trim());
    if (failed) {
      out.push({ id, now: "", failed: failed[1] });
      continue;
    }
    try {
      out.push({ id, now: String(JSON.parse(m[1].trim())) });
    } catch {
      out.push({ id, now: m[1].trim() });
    }
  }
  return out;
}
