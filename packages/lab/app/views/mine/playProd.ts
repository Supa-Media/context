/**
 * ▶ on a real text in the Lab's test chat (Lab live sandbox, Dev2 2026-11-16): reads what production logged of that
 * text's moment, from the signed-in person's own ledger (`POST /tex/page/ledger`: a person's own chat, a group's only
 * for its own people), and hands the dock the run to play (`engine/prodRun.ts`), on the graph Tex had then. Reading
 * only: nothing here writes, sends or changes a setting.
 */
import type { LedgerEntry } from "../../fromApp/texPageTypes";
import type { TexPageSource } from "../../fromApp/texPageSource";
import { LATEST } from "../../fromApp/texPageTypes";
import { jobWork, type JobWork } from "../../engine/jobRuns";
import type { PlayRun } from "../../engine/playRun";
import { prodPlayAtVersion, type ProdPlay, type ProdRow } from "../../engine/prodRun";
import { DETAIL_KINDS, JOB_KINDS, LINE_KINDS, linesOf } from "../../engine/replayRead";
import { sandbox, sharedLedger } from "../../engine/sandbox";
import { G } from "../../engine/state";
import { ledgerSource as ownSource } from "./useMine";

/** Where a chat's history is read: a shared chat's through the test chat's route, the person's own through their Tex page. */
function ledgerSource(chat?: string | null): Pick<TexPageSource, "ledger"> | null {
  const src = sandbox.source;
  if (src.kind === "shared" && (chat === undefined || chat === src.chatId)) return { ledger: (key, query) => sharedLedger(key, query) };
  return ownSource();
}

/** Pages of texts, and of a day's details, read back to find a row's moment. */
const PAGES = 40;
const DETAIL_PAGES = 10;
const MINUTE = 60_000;

type Chat = { texts: LedgerEntry[]; older: number | null; days: Map<string, LedgerEntry[]> };
const chats = new Map<string, Chat>();

/** The ledger key of the chat the test chat was opened over, or null when it isn't one of the person's own (Maya, a set). */
export function chatKeyOf(src = sandbox.source, known = sandbox.chats): string | null {
  // A chat shared with the developers is read by its own key, through the test chat's route (`sharedSource`).
  if (src.kind === "shared") return src.chatId;
  if (src.kind !== "chat") return null;
  const c = known.find((x) => x.chatId === src.chatId);
  return c?.kind === "dm" ? "me" : src.chatId;
}

/** The chat's texts read back far enough to hold `at` and the text before it. */
async function textsTo(chat: string, at: number): Promise<LedgerEntry[] | null> {
  const source = ledgerSource(chat);
  if (!source) return null;
  const c = chats.get(chat) ?? { texts: [], older: null, days: new Map() };
  chats.set(chat, c);
  const oldest = () => (c.texts.length ? Math.min(...c.texts.map((e) => e.at)) : Infinity);
  for (let i = 0; i < PAGES && (c.texts.length === 0 || (c.older !== null && oldest() > at - 5 * MINUTE)); i += 1) {
    const r = await source.ledger(chat, { kinds: LINE_KINDS, jobs: false, before: c.texts.length ? (c.older ?? LATEST) : LATEST });
    if (r.kind !== "ok") return c.texts.length ? c.texts : null;
    const known = new Set(c.texts.map((e) => e.id));
    c.texts = [...c.texts, ...r.value.entries.filter((e) => !known.has(e.id))];
    c.older = r.value.older ?? null;
    if (c.older === null) break;
  }
  return c.texts;
}

/** Every step, judging, tool call and thought of the day `at` falls on, read back to `at`. */
async function detailOf(chat: string, at: number): Promise<LedgerEntry[]> {
  const source = ledgerSource(chat);
  const c = chats.get(chat);
  if (!source || !c) return [];
  const day = new Date(at).toLocaleDateString("en-CA");
  const have = c.days.get(day);
  if (have) return have;
  const out: LedgerEntry[] = [];
  let before = LATEST;
  for (let i = 0; i < DETAIL_PAGES; i += 1) {
    const r = await source.ledger(chat, { kinds: DETAIL_KINDS, day, before });
    if (r.kind !== "ok") return out;
    out.push(...r.value.entries);
    if (r.value.older === undefined || !r.value.entries.length || !(Math.min(...r.value.entries.map((e) => e.at)) > at - MINUTE)) break;
    before = r.value.older;
  }
  c.days.set(day, out);
  return out;
}

/** For tests and a changed chat: forget what was read. */
export const forgetProd = () => chats.clear();

/**
 * Everything about a real text's run, or null when it can't be read: not a real chat of the person's own, before full
 * logging, or nothing in the log of what it ran. `get` is for tests.
 */
export async function playProd(row: ProdRow & { at: number }, chat = chatKeyOf(), get?: typeof fetch): Promise<ProdPlay | null> {
  if (!chat) return null;
  const texts = await textsTo(chat, row.at);
  if (!texts) return null;
  const detail = [...(await detailOf(chat, row.at)), ...(await detailOf(chat, row.at + MINUTE))];
  const entries = [...texts, ...detail.filter((d) => !texts.some((t) => t.id === d.id))];
  return prodPlayAtVersion(entries, linesOf(texts, chat !== "me").lines, row, G(), get);
}

/**
 * The dock's ▶ on a production row: the run to play, or null. On a person's text (or a check-in's) the whole moment as
 * it ran; on one of Tex's texts only the steps of the turn that sent it, when the log says which (never inferred).
 */
export async function playProdRow(row: { id: string; at?: number; prod?: boolean; turn?: string }, chat = chatKeyOf(), get?: typeof fetch): Promise<PlayRun | null> {
  if (row.prod === false || typeof row.at !== "number") return null;
  const p = await playProd({ id: row.id, at: row.at, ...(row.turn ? { turn: row.turn } : {}) }, chat, get);
  return p ? (p.replies[row.id] ?? (p.run.texts.some((t) => t.rowId === row.id) ? null : p.run)) : null;
}

/** The work of the background jobs a played moment ran or reported (a job's text opens to every run before it). */
export async function playProdJobs(p: ProdPlay, chat = chatKeyOf()): Promise<JobWork[]> {
  const source = ledgerSource(chat);
  if (!source || !chat) return [];
  const out: JobWork[] = [];
  for (const id of p.jobs) {
    const entries: LedgerEntry[] = [];
    let before = LATEST;
    for (let i = 0; i < 20; i += 1) {
      const r = await source.ledger(chat, { kinds: JOB_KINDS, job: id, before });
      if (r.kind !== "ok") break;
      entries.push(...r.value.entries);
      if (r.value.older === undefined || !r.value.entries.length) break;
      before = r.value.older;
    }
    out.push(jobWork(entries, id));
  }
  return out;
}
