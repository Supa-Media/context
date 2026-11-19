/**
 * `tex_dev` Replay (Dev2, 2026-11-15: anything that can be done or seen inside the Tex Lab can be done or seen through
 * the MCP): the Lab's Replay mode, read from the same chat history file and worked out by the Lab's own code
 * (`replay.generated.js`, bundled from `apps/mobile/features/tex/lab/engine/replayEntry.ts` by
 * `scripts/tex-dev-replay.mjs`):
 * - `moments`: the chat cut into moments as Replay's left column and right panel show them;
 * - `turn`: one turn with the moment's judgings, each step's real time and calls, what each step got and gave;
 * - `prompt`: the exact words of the prompt a turn ran on, from the prompt catalogue at its commit;
 * - `jobs`: a background job's runs; `mine`: the Lab's "Your texts"; `labLink`: a Lab address to any of it.
 *
 * Only what the log shows ran is shown, nothing estimated (Dev2, 2026-11-14): a module whose words are not in the
 * catalogue is named as such, never filled in.
 */

import { TEX_CONFIG } from "../agent/texConfig.js";
import { chatsOf, countOf, CUT, cutDeep, FULL_CUT, openChat, turnFrom, when } from "./probe.js";

const NEWEST = Number.MAX_SAFE_INTEGER;
/** The Lab's own Replay code, loaded the first time Replay is asked for. */
const labCode = () => import("./replay.generated.js");

export const MOMENTS_SHOWN = 20;
export const MAX_MOMENTS = 100;
export const RUNS_SHOWN = 10;
/** Lines read ahead of a `before`, so the moments just before it end where they ended. */
const AHEAD = 100;
/** The most step, judging and tool entries one read brings, newest first. */
const DETAIL_MAX = 5_000;
/** Around a turn, the window its own entries are read from. */
const BEFORE_MS = 20 * 60_000;
const AFTER_MS = 5 * 60_000;
/** A got or gave in `turn`, and a module's words in `prompt`, cut to this unless `full`. */
const IO_CUT = 600;
const WORDS_PREVIEW = 300;
export const WORDS_PAGE = 8_000;
const MAX_WORDS_PAGE = 32_000;
/** A job's runs whose other entries (a report turn's thinking and review, which carry no job id) are read too. */
const RUN_TURNS_READ = 30;
const TURN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MOMENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at;
const byAt = (a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0);
const cut = (text, max) => cutDeep(typeof text === "string" ? text : "", max);
const labelOfNode = (id) => TEX_CONFIG.nodes.find((n) => n.id === id)?.label ?? id;

/** Entries from several reads, each once, in the ledger's order. */
function union(...lists) {
  const out = new Map();
  for (const list of lists) for (const e of list ?? []) if (e && !out.has(e.id)) out.set(e.id, e);
  return [...out.values()].sort(bySeq);
}

/**
 * The conversation's lines as Replay reads them (`LINE_KINDS`, no job's work), newest `lines` before `beforeAt` and
 * the next `AHEAD` after it, cut into the person's texts and the chat's lines by the Lab (`linesOf`).
 */
async function readLines(R, ledger, name, group, { beforeAt = null, lines = 400 } = {}) {
  const older = await ledger.read(name, { before: NEWEST, kinds: R.LINE_KINDS, jobs: false, limit: lines, ...(beforeAt !== null ? { until: beforeAt } : {}) });
  const newer = beforeAt !== null ? await ledger.read(name, { since: beforeAt, kinds: R.LINE_KINDS, jobs: false, limit: AHEAD }) : { entries: [] };
  const seen = union(older.entries, newer.entries);
  return { seen, ...R.linesOf(seen, group), olderLeft: Number.isSafeInteger(older.before) };
}

/** Every entry between two times, newest first up to `DETAIL_MAX`; `slim` leaves out tool arguments and results. */
async function readSpan(R, ledger, name, since, until, { kinds = null, slim = false } = {}) {
  const read = await ledger.read(name, { before: NEWEST, since, until, limit: DETAIL_MAX, ...(kinds ? { kinds } : {}), ...(slim ? { slim: true } : {}) });
  return { entries: read.entries ?? [], capped: Number.isSafeInteger(read.before) };
}

/** What the Lab holds once a moment's day is read: the lines, and the steps' details of any job (`replayEntries`). */
const labEntriesOf = (R, seen, span) => union(seen, span.filter((e) => R.DETAIL_KINDS.includes(e.kind)));

/** A moment as Replay's right panel shows it with no step picked . */
function momentBrief(R, m, entries, timeZone) {
  const first = m.lines[0];
  const behind = m.lines.filter((l) => l.from === "person").length - (first.start ? 0 : 1);
  const waitOf = (turn) => m.lanes.Turn.find((b) => b.kind === "wait" && b.turn === turn);
  return {
    moment: m.id,
    at: first.at,
    when: when(first.at, timeZone),
    from: first.start ? R.startLabel(first) : first.who === "You" || !first.who ? "your text" : `${first.who}'s text`,
    ...(first.quiet ? { quiet: true } : {}),
    text: first.quiet ? R.QUIET_WORDS : cut(first.text, 300),
    behind,
    turns: m.turns.length,
    toLastSendMs: m.of,
    turnRuns: m.lanes.Turn.filter((b) => b.kind === "turn").map((b) => {
      const w = waitOf(b.turn);
      const waited = w ? w.end - Math.max(0, w.zero ?? w.start) : 0;
      return {
        turn: b.turn,
        ...((b.zero ?? 0) < 0 ? { alreadyRunning: true } : { startedMs: Math.max(0, b.zero ?? b.start) }),
        ...(waited > 0 ? { waitedMs: waited } : {}),
        ranMs: b.end - b.start,
        version: R.shortVersion(b.version ?? null),
        said: cut(b.detail || b.label, 200),
      };
    }),
    judge: m.lanes.Judge.map((b) => ({ atMs: b.start, said: b.label, while: b.detail })),
    jobs: R.jobsOf(entries, m.turns),
  };
}

/** The moment `id`'s first line's time: by its entry id, or for a quiet check-in (`ck:<turn>`) its turn's last line. */
async function momentAt(ledger, name, id, at) {
  if (Number.isSafeInteger(at)) return at;
  if (id.startsWith("ck:")) {
    const turn = id.slice(3);
    const read = await ledger.read(name, { before: NEWEST, kinds: ["reply", "note"], jobs: false, limit: 2_000 });
    const ats = (read.entries ?? []).filter((e) => e.turn === turn).map((e) => e.at);
    return ats.length ? Math.max(...ats) : null;
  }
  const read = await ledger.read(name, { ids: [id], limit: 1 });
  return (read.entries ?? []).find((e) => e.id === id)?.at ?? null;
}

/**
 * The moments around a time, worked out as the Lab works them out: lines read first, then every entry of the window
 * the moment found in them needs (`window(rough moments)` answers `[since, until]`), then the moments again with them.
 */
async function momentWorld(R, ledger, name, group, { beforeAt, lines, window }) {
  const read = await readLines(R, ledger, name, group, { beforeAt, lines });
  if (read.seen.length === 0) return null;
  const [since, until] = window(R.momentsOf(read.lines, read.seen), read);
  const span = await readSpan(R, ledger, name, since, until);
  const entries = labEntriesOf(R, read.seen, span.entries);
  return { read, span, entries, all: union(read.seen, span.entries), moments: R.momentsOf(read.lines, entries) };
}

/** The moment a turn is played from: the one its texts began, else the first that shows it. */
function momentOfTurn(moments, turn) {
  const has = moments.filter((m) => m.turns.includes(turn));
  return has.find((m) => m.lines[0].play?.turn === turn || (m.lines[0].start && m.lines[0].turn === turn)) ?? has[0] ?? null;
}

/**
 * `moments {chat?, before?, limit?, moment?, at?}`: the chat's moments newest first (20 unless `limit`, at most 100),
 * each as the right panel shows it; `before` (an epoch ms the last answer gave) pages back. With `moment`, that one
 * moment whole: its lines, the timeline's lanes and its rows by step, as the Lab draws them.
 */
export async function momentsAnswer(env, page, args = {}, { ledgerOf, origin }) {
  const R = await labCode();
  const { chat, place, ledger } = openChat(env, page, args.chat, ledgerOf);
  if (ledger === null) return { chat: chat.key, moments: [] };
  const group = chat.key !== "me";
  const linkOf = (moment) => labLinkOf(R, origin, { mode: "lab", view: "canvas", chat: chat.key, moment });
  if (args.moment !== undefined) return await oneMoment(R, { ledger, name: place.name, group, chat, page, args, linkOf });
  const shown = countOf(args.limit, MOMENTS_SHOWN, MAX_MOMENTS);
  const beforeAt = Number.isSafeInteger(args.before) ? args.before : null;
  const read = await readLines(R, ledger, place.name, group, { beforeAt, lines: Math.min(5_000, shown * 8 + 50) });
  if (read.seen.length === 0) return { chat: chat.key, moments: [] };
  const ats = read.seen.map((e) => e.at);
  const span = await readSpan(R, ledger, place.name, Math.min(...ats) - BEFORE_MS, Math.max(...ats) + 2 * 60_000, { kinds: R.DETAIL_KINDS, slim: true });
  const entries = labEntriesOf(R, read.seen, span.entries);
  const logged = R.loggedMoments(R.momentsOf(read.lines, entries)).filter((m) => beforeAt === null || m.lines[0].at < beforeAt);
  const list = logged.slice(-shown).reverse();
  const oldest = Math.min(...read.seen.map((e) => e.at));
  const more = logged.length > shown || (read.olderLeft && oldest >= R.LOGGED_FROM);
  return {
    chat: chat.key,
    moments: list.map((m) => ({ ...momentBrief(R, m, entries, page.timeZone), link: linkOf(m.id) })),
    ...(more && list.length ? { before: list.at(-1).lines[0].at } : {}),
    ...(span.capped ? { partial: "the oldest moments' judgings were past what one read holds; open one with moment for all of it" } : {}),
    next: "moments { moment } for one whole; turn { moment } or { turn } for a turn's steps",
  };
}

async function oneMoment(R, { ledger, name, group, chat, page, args, linkOf }) {
  if (typeof args.moment !== "string" || !MOMENT_ID.test(args.moment)) return { error: "moment takes a moment id from moments" };
  const at = await momentAt(ledger, name, args.moment, args.at);
  const world = await momentWorld(R, ledger, name, group, {
    beforeAt: at === null ? null : at + 1,
    lines: 200,
    window: (rough) => {
      const m = rough.find((x) => x.id === args.moment);
      const from = m ? m.at : (at ?? Date.now());
      return [from - BEFORE_MS, from + (m ? m.of : 0) + AFTER_MS];
    },
  });
  const m = world?.moments.find((x) => x.id === args.moment) ?? null;
  if (!m) return { error: `no moment ${args.moment} in this chat; moments lists them` };
  const bar = (b) => ({ kind: b.kind, startMs: b.start, endMs: b.end, label: b.label, ...(b.turn ? { turn: b.turn } : {}), ...(b.detail ? { detail: cut(b.detail, 300) } : {}) });
  return {
    chat: chat.key,
    ...momentBrief(R, m, world.entries, page.timeZone),
    ...(m.at < R.LOGGED_FROM ? { logged: "from before full logging (2026-11-13 23:52 UTC); the Lab does not replay it" } : {}),
    link: linkOf(m.id),
    lines: m.lines.map((l) => ({ id: l.id, tPlusMs: l.at - m.at, who: l.who, ...(l.start ? { started: R.startLabel(l) } : {}), text: l.quiet ? R.QUIET_WORDS : cut(l.text, CUT) })),
    lanes: Object.fromEntries(Object.entries(m.lanes).map(([k, bars]) => [k, bars.map(bar)])),
    // The timeline by step: each step that ran, at its measured time, as the Lab's timeline lays it out (`stepRows`).
    steps: R.stepRows(m, world.entries).map((r) => ({ step: r.id, label: r.label, ...(r.helper ? { helper: true } : {}), bars: r.bars.map((b) => ({ startMs: b.start, endMs: b.end, ran: b.label, turn: b.turn })) })),
    next: "turn { moment, turn? } for each turn's steps, what they got and gave",
  };
}

/**
 * One turn as Replay plays it: found by `turn` (and its reply's `at`) or by `moment`, with the moment's judgings and
 * tapbacks given to it (`turnShown`), its real time per step, what every step got and gave, and its entries in order.
 */
async function turnWorld(R, env, page, args, ledgerOf) {
  const hasTurn = typeof args.turn === "string";
  if (hasTurn && !TURN_ID.test(args.turn)) return { error: "turn takes a turn id from turns or moments" };
  if (!hasTurn && (typeof args.moment !== "string" || !MOMENT_ID.test(args.moment))) return { error: "name the turn: { turn } from turns, or { moment } from moments" };
  const { chat, place, ledger } = openChat(env, page, args.chat, ledgerOf);
  if (ledger === null) return { error: "this chat has no history file yet" };
  const group = chat.key !== "me";
  let around = null;
  if (hasTurn) {
    around = Number.isSafeInteger(args.at) ? args.at : null;
    if (around === null) {
      const replies = await ledger.read(place.name, { before: NEWEST, kinds: ["reply", "step"], steps: ["failed"], limit: 2_000 }); // a failed turn by its `failed` line
      around = (replies.entries ?? []).find((e) => e.turn === args.turn)?.at ?? null;
    }
  } else around = await momentAt(ledger, place.name, args.moment, args.at);
  if (around === null) return { error: hasTurn ? `no turn ${args.turn} in this chat's recent history; pass the at that turns gave` : `no moment ${args.moment} found; pass the at moments gave` };
  const world = await momentWorld(R, ledger, place.name, group, {
    beforeAt: around + 1,
    lines: 200,
    window: (rough) => {
      const m = hasTurn ? momentOfTurn(rough, args.turn) : rough.find((x) => x.id === args.moment);
      const from = Math.min(around, m?.at ?? around);
      return [from - BEFORE_MS, Math.max(around, m ? m.at + m.of : around) + AFTER_MS];
    },
  });
  if (world === null) return { error: "this chat has no texts yet" };
  const m = hasTurn ? momentOfTurn(world.moments, args.turn) : (world.moments.find((x) => x.id === args.moment) ?? null);
  if (!hasTurn && !m) return { error: `no moment ${args.moment} in this chat; moments lists them` };
  const turn = hasTurn ? args.turn : m.turns[0];
  if (!turn) return { error: `no turn was logged for moment ${args.moment}` };
  const shown = m ? R.turnShown(m, world.read.lines, world.entries, turn) : null;
  const reply = world.all.find((e) => e.kind === "reply" && e.turn === turn);
  const times = shown ? shown.times : R.realTimes(world.entries, turn);
  const io = shown ? shown.io : R.realIO(world.entries, turn, "", typeof reply?.text === "string" ? reply.text : "");
  const prompt = shown ? shown.prompt : R.turnPromptOf(world.entries, turn);
  const mine = (m ? R.momentTurnEntries(m, world.all, turn) : world.all).filter((e) => e.turn === turn).sort(byAt);
  return { R, chat, turn, m, world, times, io, prompt, mine, ledger, name: place.name };
}

/** `turn {chat?, turn | moment, at?, node?, full?}`. */
export async function turnAnswer(env, page, args = {}, { ledgerOf, origin }) {
  const R = await labCode();
  const t = await turnWorld(R, env, page, args, ledgerOf);
  if (t.error) return t;
  if (t.mine.length === 0) return { error: `no entries for turn ${t.turn}` };
  const full = args.full === true;
  const max = full ? FULL_CUT : IO_CUT;
  const node = typeof args.node === "string" ? args.node : null;
  const io = Object.fromEntries(Object.entries(t.io).filter(([id]) => node === null || id === node).map(([id, lines]) => [id, lines.map((l) => ({ k: l.k, v: cut(l.v, node === null ? max : full ? FULL_CUT : CUT) }))]));
  const nodes = Object.entries(t.times?.ms ?? {})
    .map(([id, ms]) => ({ node: id, label: labelOfNode(id), ms, ...(t.times.calls[id] ? { calls: t.times.calls[id] } : {}) }))
    .sort((a, b) => b.ms - a.ms);
  const base = turnFrom(t.mine, { timeZone: page.timeZone, full, ...(typeof args.detail === "string" ? { detail: args.detail } : {}) });
  const p = t.prompt;
  return {
    chat: t.chat.key,
    turn: t.turn,
    ...(t.m ? { moment: t.m.id, link: labLinkOf(R, origin, { mode: "lab", view: "canvas", chat: t.chat.key, moment: t.m.id }), otherTurns: t.m.turns.filter((x) => x !== t.turn) } : { moment: null }),
    when: base.when,
    // What the log measured, per step of the canvas (`realTimes`): the person's wait, and each step's time and calls.
    real: t.times ? { waitedMs: t.times.reply, nodes } : null,
    io,
    jobs: R.jobsOf(t.world.entries, [t.turn]),
    reads: R.readsOf(t.world.all, t.turn),
    prompt: p ? { code: p.code, setup: p.setup, rounds: p.rounds.length, modules: p.rounds[0]?.modules.length ?? 0, next: "prompt { turn } for its words" } : null,
    summary: base.summary,
    order: base.order,
  };
}

/** `prompt {chat?, turn | moment, at?, round?, node?, module?, from?, limit?, full?}`. */
export async function promptAnswer(env, page, args = {}, { ledgerOf, fetch: get = globalThis.fetch }) {
  const R = await labCode();
  const node = args.node ?? null;
  if (node !== null && node !== "fd" && node !== "door") return { error: "only the front door's rounds log a prompt: node fd (every round) or door (the modules it built, round 1)" };
  const t = await turnWorld(R, env, page, args, ledgerOf);
  if (t.error) return t;
  const p = t.prompt;
  if (!p) return { chat: t.chat.key, turn: t.turn, prompt: null, why: "this turn logged no prompt modules and no version (before 2026-11-14 16:00 UTC, or a turn with no model round)" };
  const cat = p.code ? await R.catalogAt(p.code, get) : null;
  const told = R.toldTime(p.inputs);
  const full = args.full === true;
  const words = (m) => R.wordsOf(cat, m, p.kept ?? null); // the catalogue's, or the words the turn kept, each proven by its fingerprint
  const one = Number.isSafeInteger(args.round) ? args.round : node === "door" ? 1 : null;
  if (typeof args.module === "string") {
    const rounds = p.rounds.map((r, i) => ({ r, i })).filter(({ i }) => one === null || i + 1 === one);
    const hit = rounds.flatMap(({ r, i }) => r.modules.map((m) => ({ m, i }))).find(({ m }) => m.id === args.module);
    if (!hit) return { error: `no module ${args.module} in ${one === null ? "this turn's prompt" : `round ${one}`}` };
    const w = words(hit.m);
    if (w === null) return { module: hit.m.id, round: hit.i + 1, chars: hit.m.n, fingerprint: hit.m.h, words: null, why: whyNot(R, cat, p, hit.m, told) };
    const from = Number.isSafeInteger(args.from) && args.from > 0 ? args.from : 0;
    const limit = countOf(args.limit, WORDS_PAGE, MAX_WORDS_PAGE);
    return { module: hit.m.id, round: hit.i + 1, chars: w.length, fingerprint: hit.m.h, from, words: w.slice(from, from + limit), ...(from + limit < w.length ? { more: { from: from + limit } } : {}) };
  }
  const missing = new Set();
  const key = (r) => r.modules.map((m) => m.h).join(",");
  const rounds = p.rounds
    .map((r, i) => {
      if (one !== null && i + 1 !== one) return null;
      if (one === null && i > 0 && key(r) === key(p.rounds[i - 1])) return { round: i + 1, model: r.model, same: `the same modules as round ${i}` };
      return {
        round: i + 1,
        model: r.model,
        modules: r.modules.map((m) => {
          const w = words(m);
          if (w === null) missing.add(m.id);
          return { id: m.id, chars: m.n, fingerprint: m.h, ...(w !== null ? { words: full ? cut(w, FULL_CUT) : cut(w, WORDS_PREVIEW) } : { words: null, why: whyNot(R, cat, p, m, told) }) };
        }),
      };
    })
    .filter(Boolean);
  return {
    chat: t.chat.key,
    turn: t.turn,
    code: p.code,
    ...(p.code ? { commit: R.commitUrl(p.code) } : {}),
    setup: p.setup,
    ...(p.inputs?.model ? { model: p.inputs.model } : {}),
    ...(typeof p.inputs?.history === "number" ? { earlierTurns: p.inputs.history } : {}),
    ...(told ? { told } : {}),
    catalogue: !p.code ? "no commit logged; only words the turn kept, proven by their fingerprints, are shown" : cat ? "read at this commit; each module's words are shown only where its fingerprint is in it, or the turn kept words with that fingerprint" : "none read at this commit (it ran before 2026-11-14, or the file could not be fetched just now); only words the turn kept, proven by their fingerprints, are shown",
    rounds,
    notInCatalogue: [...missing],
    next: "prompt { turn, module, from?, limit? } for one module's whole words",
  };
}

/** Why a module's words are not shown, as the Lab says it (`PromptAt.tsx`); never a guess at them. */
function whyNot(R, cat, p, m, told) {
  const source = `${m.id === "preamble/now" && told ? `The time: ${told}. ` : ""}From ${R.moduleSource(m.id)}`;
  if (!p.code) return `${source}; no commit was logged`;
  if (!cat) return `${source}; no catalogue at this commit`;
  return `${source}. ${R.fromRepo(m.id) ? "Not in this version's catalogue (a chat's own progress level, say)" : "Built from their own words when the turn ran, and not kept: the turn ran before 2026-11-17, or the module was too long to keep"}`;
}

/** One job's work as the Lab reads it (`readJobWork`): its entries by id, and its runs' own turns' entries. */
async function jobWorkOf(R, ledger, name, id) {
  const read = await ledger.read(name, { before: NEWEST, kinds: R.JOB_KINDS, job: id, limit: DETAIL_MAX });
  let entries = union(read.entries);
  const turns = [...new Set(entries.map((e) => e.turn).filter((x) => typeof x === "string" && x))];
  for (const turn of turns.slice(-RUN_TURNS_READ)) {
    const ats = entries.filter((e) => e.turn === turn).map((e) => e.at);
    const span = await readSpan(R, ledger, name, Math.min(...ats) - 2 * 60_000, Math.max(...ats) + 2 * 60_000, { kinds: R.JOB_KINDS });
    entries = union(entries, span.entries.filter((e) => e.turn === turn));
  }
  return R.jobWork(entries, id);
}

/** `jobs {chat?, job | turn | moment, from?, limit?, full?}`: a job's runs as JobRuns shows them, oldest first. */
export async function jobsAnswer(env, page, args = {}, { ledgerOf }) {
  const R = await labCode();
  let ids;
  let chatKey;
  let ledger;
  let name;
  if (typeof args.job === "string") {
    if (!TURN_ID.test(args.job)) return { error: "job takes a job id from a turn's or a moment's jobs" };
    const opened = openChat(env, page, args.chat, ledgerOf);
    if (opened.ledger === null) return { error: "this chat has no history file yet" };
    [chatKey, ledger, name, ids] = [opened.chat.key, opened.ledger, opened.place.name, [args.job]];
  } else if (typeof args.turn === "string" || typeof args.moment === "string") {
    const t = await turnWorld(R, env, page, args, ledgerOf);
    if (t.error) return t;
    [chatKey, ledger, name] = [t.chat.key, t.ledger, t.name];
    ids = R.jobsOf(t.world.entries, typeof args.turn === "string" || !t.m ? [t.turn] : t.m.turns).map((j) => j.id);
  } else return { error: "jobs takes a job id, or a turn or moment whose jobs to show" };
  const full = args.full === true;
  const max = full ? FULL_CUT : 400;
  const shown = countOf(args.limit, RUNS_SHOWN, MAX_MOMENTS);
  const jobs = [];
  for (const id of ids) {
    const w = await jobWorkOf(R, ledger, name, id);
    const from = Number.isSafeInteger(args.from) && args.from >= 0 ? args.from : Math.max(0, w.runs.length - shown);
    let n = 0;
    const runs = w.runs.map((r) => ({ r, n: r.report !== null ? n : ++n })).slice(from, from + shown);
    jobs.push({
      job: w.id,
      title: w.title,
      runs: w.runs.length,
      ...(w.runs.length ? { span: { from: when(w.runs[0].start, page.timeZone), to: when(w.runs.at(-1).end, page.timeZone) } } : {}),
      shown: { from, to: from + runs.length },
      list: runs.map(({ r, n: i }) => ({
        run: r.report !== null ? "report" : i,
        turn: r.turn,
        when: when(r.start, page.timeZone),
        ms: r.end - r.start,
        check: R.stateWords(r.state),
        ...(r.advice ? { advice: cut(r.advice, full ? FULL_CUT : CUT) } : {}),
        ...(r.report !== null || r.said ? { [r.report !== null ? "reported" : "said"]: cut(r.report ?? r.said, full ? FULL_CUT : CUT) } : {}),
        ...(r.model ? { model: r.model } : {}),
        tools: r.tools.map((x) => ({ tPlusMs: x.at - r.start, name: x.name, ok: x.ok, ms: x.ms, args: cutDeep(x.args, max), result: cutDeep(x.result, max) })),
        thinking: r.thinking.map((x) => ({ ms: x.ms, text: cut(x.text, max) })),
        steps: r.steps.map((s) => ({ what: String(s.step ?? s.kind), ...(typeof s.ms === "number" ? { ms: s.ms } : {}), ...cutDeep({ input: s.input, output: s.output ?? s.text ?? s.notice }, max) })),
      })),
    });
  }
  return { chat: chatKey, jobs, ...(jobs.length === 0 ? { note: "no background job ran or reported in it" } : {}) };
}

/**
 * `mine {chat?, before?, limit?, q?, pick?}`: the Lab's "Your texts" (Test cases, as You): the person's texts newest
 * first, each with the chat just before it, what Tex said then, which Tex that was and the notes its turn read; `pick`
 * (text ids) answers the run config's replays for those, as ticking them in the Lab does.
 */
export async function mineAnswer(env, page, args = {}, { ledgerOf, session }) {
  const R = await labCode();
  const { chat, place, ledger } = openChat(env, page, args.chat, ledgerOf);
  if (ledger === null) return { chat: chat.key, texts: [] };
  const shown = countOf(args.limit, MOMENTS_SHOWN, MAX_MOMENTS);
  const read = await ledger.read(place.name, { before: Number.isSafeInteger(args.before) ? args.before : NEWEST, kinds: R.LINE_KINDS, jobs: false, limit: Math.min(5_000, shown * 6 + 50) });
  const seen = union(read.entries);
  const q = typeof args.q === "string" ? args.q.toLowerCase() : "";
  const texts = R.myTexts(seen).filter((t) => !q || `${t.text} ${t.then.text}`.toLowerCase().includes(q));
  const list = texts.slice(0, shown);
  if (list.length === 0) return { chat: chat.key, texts: [] };
  const ats = list.map((t) => t.at);
  const tools = await ledger.read(place.name, { before: NEWEST, kinds: ["tool"], since: Math.min(...ats), until: Math.max(...ats) + 30 * 60_000, limit: DETAIL_MAX, slim: true, keepArgs: ["fetch", "read_note", "read", "open_note"] });
  const reads = Object.fromEntries(list.map((t) => [t.id, R.readsOf(tools.entries ?? [], t.turn)]));
  const picked = Array.isArray(args.pick) ? list.filter((t) => args.pick.includes(t.id)) : [];
  const handle = session?.workspaces?.find((w) => w.kind === "personal" && w.role === "owner")?.slug ?? null;
  const more = texts.length > shown ? list.at(-1).seq : read.before;
  return {
    chat: chat.key,
    texts: list.map((t) => ({
      id: t.id,
      at: t.at,
      when: when(t.at, page.timeZone),
      ...(t.who ? { who: t.who } : {}),
      text: cut(t.text, 500),
      earlier: t.earlier.map((l) => ({ from: l.from, text: cut(l.text, 200) })),
      then: { text: cut(t.then.text, 500), version: R.shortVersion(t.then.version), ...(t.then.version ? { stamp: t.then.version } : {}) },
      turn: t.turn,
      reads: reads[t.id],
    })),
    ...(Number.isSafeInteger(more) ? { before: more } : {}),
    ...(picked.length && handle ? { runConfig: R.replayConfig(picked, reads, { handle, name: handle }), use: "put runConfig in the run's config (pnpm ai lab replay)" } : {}),
  };
}

/** A Lab address: `/lab` with the Lab's own place in it (`labPlace.ts`), a draft's `v` first when one is named. */
export function labLinkOf(R, origin, place, draft = null) {
  const search = R.searchOf(place);
  const v = draft ? `v=${encodeURIComponent(draft)}` : "";
  return `${origin}/lab${v ? `?${v}${search ? "&" + search.slice(1) : ""}` : search}`;
}

const PAGES = ["canvas", "modules", "convo", "tools", "sim", "tests", "run", "compare"];

/**
 * `link {draft?, mode?, page?, chat?, moment?}`: the address the Lab opens at: its canvas at a chat and a text (implied
 * by a chat or a moment; `mode: "replay"` still names it, since Replay is part of the Lab), or the Lab at one of its pages.
 */
export async function linkAnswer(page, args, { origin, draft }) {
  const R = await labCode();
  const replay = args.mode === "replay" || args.chat !== undefined || args.moment !== undefined;
  // Replay is not a mode of the Lab any more: a chat and a text are an address on its canvas.
  if (args.mode !== undefined && args.mode !== "replay" && args.mode !== "lab") return { error: 'mode is "lab" or "replay"' };
  if (args.page !== undefined && !PAGES.includes(args.page)) return { error: `page is one of ${PAGES.join(", ")}` };
  if (replay && args.page !== undefined && args.page !== "canvas") return { error: "A chat and a text open on the canvas; leave page out" };
  const chat = args.chat ?? "me";
  if (replay && !chatsOf(page).some((c) => c.chat === chat)) return { error: "There is no such chat; chats lists yours." };
  if (args.moment !== undefined && (typeof args.moment !== "string" || !MOMENT_ID.test(args.moment))) return { error: "moment takes a moment id from moments" };
  const place = { mode: "lab", view: replay ? "canvas" : (args.page ?? "canvas"), chat, moment: args.moment ?? null };
  // The address must read back as the place it was written from, or the Lab would open somewhere else.
  const back = R.placeOf(R.searchOf(place));
  if (JSON.stringify(back) !== JSON.stringify(place)) return { error: "That place is not one the Lab's address holds." };
  return {
    link: labLinkOf(R, origin, place, draft),
    note: replay ? "Opens the Lab at that chat and text; staff sign-in." : "Opens the Lab at that page; staff sign-in.",
  };
}
