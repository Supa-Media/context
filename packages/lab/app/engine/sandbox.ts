/**
 * The test chat under the Architecture canvas (Dev2, 2026-11-16: "I need the ability to test new architecture changes
 * and send test texts to the new architecture without having to put it in prod ... use maya, or my users existing 1:1
 * or group chats ... write as anyone in the group, delete some test messages and retry, and also have all the changes
 * in the workspace / group chat object be sandboxed so it doesnt actually affect production").
 *
 * The gateway keeps the test chat (`POST /tex-lab/sandbox`): it reads the real chat, runs the version open in the Lab
 * on live models, keeps every write in a throwaway copy and sends nothing anywhere. This is its state in the Lab and
 * the calls that change it; the same ops are tex_dev's `sandbox` action.
 */
import { useSyncExternalStore } from "react";
import type { StepCell } from "../views/grid/TextGrid.web";
import { stepExtra, type StepExtra } from "./stepRun";
import { lab, set as setLab } from "./state";
import { unfoldGroups } from "./groups";
import type { LedgerPage, LedgerQuery } from "../fromApp/texPageTypes";
import { readLedgerPage } from "../fromApp/texPageLedger";
import type { Read } from "../fromApp/texPageSource";

/** A step as the grid shows it (`out` in words) with the contract's optional fields (`stepRun.ts`), as the gateway sent them. */
export type SandboxStep = StepCell & StepExtra;

export type SandboxSource =
  | { kind: "maya" }
  | { kind: "chat"; chatId: string; name: string }
  | { kind: "set"; convId: string; name: string; chatId?: string }
  /** A chat someone shared with the developers (`readSandboxShared`): its real texts play what ran, and a test text runs as its person. */
  | { kind: "shared"; chatId: string; name: string };
/** A chat shared with the developers, as the gateway lists it (`labSandbox/shared.js`). */
export type SharedChat = { chatId: string; name: string; kind: "dm" | "group"; people: number; sharedBy: string[]; lastAt: number | null };
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
  /** A row that is a tapback, an edit or an unsend on another text, not a text of its own. */
  kind?: "reaction" | "edit" | "unsend";
};
/** The tapbacks iMessage has, in its order. */
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
/**
 * One thing a test turn wrote (the gateway's `writes`): its kind and the line that says it, and, where it has them, the
 * contract's fields to open it with: a page's address (read back with op `page`), an email's `to`/`subject`/`body`, a
 * note's `body`.
 */
export type SandboxWrite = { kind: string; summary: string; by?: string; id?: string; title?: string; body?: string; url?: string; to?: string; subject?: string; expires?: number };
/** The phone line a test text goes over (`get`'s `line`): its name and the number a text arrives on. */
export type SandboxLine = { name: string; number?: string };
export type SandboxState = {
  id: string | null;
  source: SandboxSource;
  versionId: string;
  /** Who may send, by name; `handles` is each one's handle, sent as `as` (a name not in it is sent as a guest). */
  people: string[];
  handles: Record<string, string>;
  as: string;
  rows: SandboxRow[];
  writes: SandboxWrite[];
  /** The test text whose turn is running, and the step running now. */
  running: string | null;
  hot: string | null;
  busy: boolean;
  problem: string | null;
  /**
   * A test chat a link asked for (`/lab?testchat=<id>`) that is not open yet: the dock names it and offers to try again
   * instead of showing whatever chat was open before, so a failed open never looks like the wrong chat.
   */
  linked: string | null;
  /** The chats you may open a test chat over (your 1:1 and your group chats). */
  chats: Array<{ chatId: string; name: string; kind?: "dm" | "group"; people?: number }>;
  /** The chats people shared with the developers (Settings → Feedback, or "Tex, share my chats with the devs"). */
  sharedChats: SharedChat[];
  /** The Training and Dev conversations a test chat may start from (the gateway's `sets`; never the Test set). */
  sets: Array<{ id: string; title: string; set: "training" | "dev"; group: boolean; texts: number }>;
  /** A text waiting in the composer: `tryFromHere` puts the text it tries from there. */
  draft: { as: string; text: string } | null;
  /**
   * A test chat opened by its id (`/lab?testchat=<id>`, or picked from Recent test chats), which an AI or another tab
   * may be texting too (Dev2, 2026-11-16: AIs drive sandboxes and Dev2 co-works live): read again while idle, so a text
   * anyone sends shows and plays, and never swapped for a fresh one when the Lab opens another version.
   */
  shared: boolean;
  /** Recent test chats (the gateway's `list`), newest first; null until read, or when the gateway has no `list`. */
  recent: SandboxRecent[] | null;
  /** The line every new text uses, once the gateway has said it. */
  line?: SandboxLine | null;
  /**
   * Whether this test chat runs the version as drawn (`draftFit`, gateway `agent/texConfig.js`): a draft's steps with
   * no code yet do not run, steps it removes still run as main's. Said on the chat, so a run is never read as the draft's
   * when it was main's (2026-11-16).
   */
  fit: { asDrawn: boolean; says?: string } | null;
  /**
   * Whose code answers the next test chat opened: "main" (this deployment) or a pull request, "#<number>", whose own
   * preview runs it with its fictional people (Dev2, 2026-11-22: "run on PR #N's code").
   */
  code: string;
  /** The open test chat's pull request, when it runs on one, and whether its preview is still starting (about a minute). */
  preview: { pr: number; starting: boolean } | null;
};

/** One of the recent test chats, whoever opened it: the Lab or an AI through `tex_dev`. */
export type SandboxRecent = { sandboxId: string; name: string; source: SandboxSource; versionId: string; openedBy: string; lastBy: string; at: number; ai: boolean; texts: number; running: boolean };

export type SandboxOp = "chats" | "sets" | "shared" | "ledger" | "open" | "send" | "react" | "edit" | "unsend" | "retry" | "back" | "drop" | "reset" | "get" | "list" | "use" | "page" | "nightly";
export type SandboxCall = (op: SandboxOp, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const sandbox: SandboxState = { id: null, source: { kind: "maya" }, versionId: "main", people: [], handles: {}, as: "", rows: [], writes: [], running: null, hot: null, busy: false, problem: null, linked: null, chats: [], sharedChats: [], sets: [], draft: null, shared: false, recent: null, fit: null, line: null, code: "main", preview: null };

const subs = new Set<() => void>();
let ver = 0;
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};
export function useSandbox(): SandboxState {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ver,
    () => ver,
  );
  return sandbox;
}

let call: SandboxCall | null = null;
/** The gateway route, set by the Lab once it has a grant for the person's own workspace (`SandboxLoader`). */
/** Whose code the next test chat runs: "main", or a pull request ("#4012", "4012"); `null` when it is neither. */
export function setSandboxCode(code: string): string | null {
  const t = code.trim();
  const m = /^(?:#|pr)?([1-9][0-9]{0,6})$/i.exec(t);
  const next = !t || t === "main" ? "main" : m ? "#" + m[1] : null;
  if (next !== null && next !== sandbox.code) {
    sandbox.code = next;
    emit();
  }
  return next;
}

export function setSandboxCall(c: SandboxCall | null) {
  call = c;
}

/**
 * A gateway route op a Lab panel asks with the test chat's grant, outside the test chat's own state (the Search page's
 * "Try a search" panel, `op: "search"`). The same call every sandbox op makes.
 */
export function callSandboxRoute(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!call) return Promise.reject(new Error("Sign in to the console to use the test chat"));
  return call(op as SandboxOp, body);
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
    ...(r.kind === "reaction" || r.kind === "edit" || r.kind === "unsend" ? { kind: r.kind } : {}),
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

/** A test chat page's id: the last part of its address, else the write's own id. */
/** A page's id in the sandbox: the last segment of its address (an id, never a name shown), else the write's own id. */
const lastSegment = (url: string) => {
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1);
};
export const pageIdOf = (w: SandboxWrite) => (w.url ? lastSegment(w.url) : "") || w.id || "";

/** One of the test chat's pages, read back whole (op `page`): its title and its Markdown, as text. */
export async function readSandboxPage(id: string): Promise<{ title: string; text: string }> {
  if (!call || !sandbox.id) throw new Error("Sign in to the console to use the test chat");
  const b = await call("page", { sandboxId: sandbox.id, id });
  return { title: str(b.title), text: str(b.text) };
}

/** The rows as the gateway last sent them, whole: a `get` with `after` sends only what follows the chat's real texts. */
let rawRows: Record<string, unknown>[] = [];

/** The last of the real chat's texts the test chat opened on: they never change, so a look asks only for what follows. */
function lastRealId(): string | null {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) if (rawRows[i].prod === true && typeof rawRows[i].id === "string") return rawRows[i].id as string;
  return null;
}

/**
 * Each new text in the test chat, whoever sent it (you, an AI, another tab): the playback follows it
 * (`sandboxPlay.ts`). Not the texts a chat opens with, and not tapbacks, edits or Tex's own.
 */
let onText: ((msgId: string) => void) | null = null;
export function onSandboxText(f: ((msgId: string) => void) | null) {
  onText = f;
}
let seenFor: string | null = null;
let seen = new Set<string>();

function take(b: Record<string, unknown>) {
  if (typeof b.sandboxId === "string") sandbox.id = b.sandboxId;
  // A test chat on a pull request's preview: `starting` until the preview's own test chat is open (the GitHub run).
  const pv = b.preview && typeof b.preview === "object" ? (b.preview as Record<string, unknown>) : null;
  const pr = typeof b.code === "string" ? Number(b.code.replace("#", "")) : num(pv?.pr);
  if (pr) sandbox.preview = { pr, starting: pv?.starting === true };
  else if (sandbox.preview && Array.isArray(b.rows)) sandbox.preview = { ...sandbox.preview, starting: false };
  if (b.fit && typeof b.fit === "object") {
    const f = b.fit as Record<string, unknown>;
    sandbox.fit = { asDrawn: f.asDrawn !== false, ...(typeof f.says === "string" ? { says: f.says } : {}) };
  }
  if (Array.isArray(b.people)) {
    // `{handle, name}` each, or a bare name.
    const ps = arr<unknown>(b.people).map((x) => (typeof x === "string" ? { handle: x, name: x } : x && typeof x === "object" ? { handle: str((x as Record<string, unknown>).handle), name: str((x as Record<string, unknown>).name) } : null)).filter((x): x is { handle: string; name: string } => !!x && !!(x.name || x.handle));
    sandbox.people = ps.map((x) => x.name || x.handle);
    sandbox.handles = Object.fromEntries(ps.map((x) => [x.name || x.handle, x.handle]));
  }
  if (Array.isArray(b.rows)) {
    const raw = arr<Record<string, unknown>>(b.rows);
    rawRows = raw;
    const rows = raw.map(rowOf);
    // A reply row carries the steps of the text it answers (`reply`): the grid shows them on that text's row.
    raw.forEach((r, i) => {
      const to = typeof r.reply === "string" ? rows.find((x) => x.id === r.reply) : undefined;
      if (to && !to.steps?.length && rows[i].steps?.length) to.steps = rows[i].steps;
      if (to) rows[i].steps = [];
      if (typeof r.error === "string" && r.error) rows[i].text = (rows[i].text ? rows[i].text + " · " : "") + "Didn't finish: " + r.error;
      if (rows[i].text) rows[i].quiet = rows[i].quiet && !r.error;
    });
    // A test text is kept under the handle it was sent as: shown by the person's name.
    const nameOf = Object.fromEntries(Object.entries(sandbox.handles).filter(([, h]) => h).map(([n, h]) => [h, n]));
    rows.forEach((r) => (r.who = nameOf[r.who] ?? r.who));
    sandbox.rows = rows;
    const fresh = sandbox.id && seenFor === sandbox.id ? rows.filter((r) => !seen.has(r.id) && !r.tex && !r.kind && !r.prod) : [];
    seen = new Set(rows.map((r) => r.id));
    seenFor = sandbox.id;
    if (fresh.length) queueMicrotask(() => onText?.(fresh[fresh.length - 1].id));
  }
  if (Array.isArray(b.writes)) sandbox.writes = arr<Record<string, unknown>>(b.writes).map(writeOf);
  if (b.line && typeof b.line === "object") {
    const l = b.line as Record<string, unknown>;
    sandbox.line = { name: str(l.name), ...(str(l.number) ? { number: str(l.number) } : {}) };
  }
  sandbox.running = typeof b.running === "string" ? b.running : b.running && typeof b.running === "object" ? str((b.running as Record<string, unknown>).msgId) || null : null;
  sandbox.hot = b.running && typeof b.running === "object" ? str((b.running as Record<string, unknown>).node) || null : typeof b.hot === "string" ? b.hot : null;
  // A chat opened by its id may not say who is in it: whoever has texted in it, by name.
  if (!sandbox.people.length && sandbox.shared) for (const r of sandbox.rows) if (!r.tex && r.who && !sandbox.people.includes(r.who)) sandbox.people.push(r.who);
  if (!sandbox.as || !sandbox.people.includes(sandbox.as)) sandbox.as = sandbox.people[0] || "";
}

let polling: ReturnType<typeof setTimeout> | null = null;
const POLL_MS = 700;
/** A shared test chat is read this often while nothing runs, so a text an AI sends shows. */
const IDLE_POLL_MS = 2500;
function poll() {
  if (polling) clearTimeout(polling);
  polling = null;
  if (!sandbox.id || (!sandbox.running && !sandbox.shared && !sandbox.preview?.starting)) return;
  const after = lastRealId();
  polling = setTimeout(() => void run("get", after ? { after } : {}, false), sandbox.running ? POLL_MS : IDLE_POLL_MS);
}

/** The ops that run the draft: each carries it as drawn while it has edits not saved yet. */
const DRAFT_OPS = new Set<SandboxOp>(["open", "send", "react", "edit", "unsend", "retry", "use", "nightly"]);

/**
 * The draft open in the Lab as drawn, when the test chat runs it and the saved copy isn't it: never saved, or edited
 * since (Dev2, 2026-11-16: an unsaved draft left the test chat on "There is no such draft." and its history unplayable).
 * Saved the way Save saves it (`store.ts`): the steps unfolded.
 */
export function drawnDraft(versionId: string): string | null {
  if (versionId === "main" || lab.cur.id !== versionId) return null;
  if (!lab.dirty && lab.versions.some((v) => v.id === versionId)) return null;
  return JSON.stringify(unfoldGroups(lab.cur.graph));
}

async function run(op: SandboxOp, body: Record<string, unknown>, busy = true) {
  if (DRAFT_OPS.has(op)) {
    const drawn = drawnDraft(typeof body.versionId === "string" ? body.versionId : sandbox.versionId);
    if (drawn !== null) body = { ...body, graph: drawn };
  }
  if (!call) {
    sandbox.problem = "Sign in to the console to use the test chat";
    emit();
    return;
  }
  if (busy) sandbox.busy = true;
  sandbox.problem = null;
  emit();
  try {
    const b = await call(op, op === "open" ? body : { sandboxId: sandbox.id, ...body });
    // Only the rows after the real texts came back (`total` says so): the real ones are the ones kept.
    if (op === "get" && typeof body.after === "string" && typeof b.total === "number" && Array.isArray(b.rows)) {
      const at = rawRows.findIndex((r) => r.id === body.after);
      b.rows = at >= 0 ? [...rawRows.slice(0, at + 1), ...arr<Record<string, unknown>>(b.rows)] : await call("get", { sandboxId: sandbox.id }).then((full) => full.rows);
    }
    if (op === "reset") {
      // Reset deletes the test chat.
      rawRows = [];
      Object.assign(sandbox, { id: null, rows: [], writes: [], running: null, hot: null, shared: false });
    } else if (Array.isArray(b.rows) || op === "open") take(b);
    // send and retry answer the new text's id: the rows, and its turn running, come from get.
    else if (sandbox.id) take(await call("get", { sandboxId: sandbox.id }));
  } catch (e) {
    sandbox.problem = e instanceof Error ? e.message : "The test chat didn't answer";
    sandbox.running = null;
  }
  sandbox.busy = false;
  emit();
  poll();
}

/** The chats you may open a test chat over. */
export async function readSandboxChats() {
  if (!call) return;
  try {
    const b = await call("chats", {});
    sandbox.chats = arr<Record<string, unknown>>(b.chats)
      .map((c) => ({ chatId: str(c.chatId), name: str(c.name), ...(c.kind === "1:1" || c.kind === "dm" ? { kind: "dm" as const } : c.kind === "group" ? { kind: "group" as const } : {}), ...(num(c.people) != null ? { people: num(c.people)! } : {}) }))
      .filter((c) => c.chatId);
    emit();
  } catch (e) {
    // Said, not swallowed: an empty list read as "no chats" hid a gateway route that answered 404 (2026-11-16).
    sandbox.problem = "Your chats didn't load: " + (e instanceof Error ? e.message : "the test chat didn't answer");
    emit();
  }
}

/**
 * The chats people shared with the developers (Dev2, 2026-11-16: "a new category, shared with developers ... click
 * through histories and see and replay things and debug issues"). Asked again every time the tab opens, so a person who
 * stopped sharing is gone.
 */
export async function readSandboxShared() {
  if (!call) return;
  try {
    const b = await call("shared", {});
    sandbox.sharedChats = arr<Record<string, unknown>>(b.chats)
      .map((c) => ({ chatId: str(c.chatId), name: str(c.name) || "Shared chat", kind: c.kind === "group" ? ("group" as const) : ("dm" as const), people: num(c.people) ?? 1, sharedBy: arr<unknown>(c.sharedBy).filter((h): h is string => typeof h === "string"), lastAt: num(c.lastAt) }))
      .filter((c) => c.chatId);
    emit();
  } catch (e) {
    sandbox.problem = "The shared chats didn't load: " + (e instanceof Error ? e.message : "the test chat didn't answer");
    emit();
  }
}

/**
 * A shared chat's history file, a page at a time, as a person's own Tex page reads theirs (`playProd.ts` plays a real
 * text from it). Through the test chat's route, which asks the control plane again whether it is still shared.
 */
export async function sharedLedger(chatId: string, query: LedgerQuery): Promise<Read<LedgerPage>> {
  if (!call) return { kind: "failed" };
  try {
    const b = await call("ledger", { chatId, ...query });
    const page = readLedgerPage(b);
    return page ? { kind: "ok", value: page } : { kind: "failed" };
  } catch (e) {
    return /isn't shared|no longer/.test(e instanceof Error ? e.message : "") ? { kind: "notYours" } : { kind: "failed" };
  }
}

/** A problem the test chat shows (a picture that didn't upload). */
export function sandboxProblem(problem: string | null) {
  sandbox.problem = problem;
  emit();
}

/** The Training and Dev conversations, as the gateway lists them. */
export async function readSandboxSets() {
  if (!call) return;
  try {
    const b = await call("sets", {});
    sandbox.sets = arr<Record<string, unknown>>(b.sets)
      .filter((c) => c.set === "training" || c.set === "dev")
      .map((c) => ({ id: str(c.id), title: str(c.title) || str(c.id), set: c.set as "training" | "dev", group: c.kind === "group", texts: num(c.texts) ?? 0 }))
      .filter((c) => c.id);
    emit();
  } catch {
    /* the tab says there are none */
  }
}

/** Open a test chat over Maya or one of your chats, running the version open in the Lab. */
export function openSandbox(source: SandboxSource, versionId: string, base?: string) {
  sandbox.shared = false;
  sandbox.linked = null;
  seenFor = null;
  sandbox.source = source;
  sandbox.versionId = versionId;
  sandbox.id = null;
  sandbox.rows = [];
  sandbox.writes = [];
  sandbox.running = null;
  sandbox.hot = null;
  sandbox.fit = null;
  sandbox.preview = null;
  const code = sandbox.code !== "main" ? { code: sandbox.code } : {};
  return run("open", { ...code, source: source.kind, ...(source.kind === "chat" || source.kind === "shared" ? { chatId: source.chatId } : source.kind === "set" ? { convId: source.convId, ...(source.chatId ? { chatId: source.chatId } : {}) } : {}), versionId, ...(base ? { base } : {}) });
}
/** What a `list` entry's source says, as a source the picker and Reset can open again. */
function sourceOf(c: Record<string, unknown>): SandboxSource {
  const chat = c.chat && typeof c.chat === "object" ? (c.chat as Record<string, unknown>) : {};
  const name = str(chat.name) || str(chat.title) || (typeof c.chat === "string" ? c.chat : "") || "Test chat";
  const kind = str(c.source) || str(c.kind);
  if (kind === "maya") return { kind: "maya" };
  const convId = str(chat.convId) || str(c.convId);
  const chatId = str(chat.chatId) || str(c.chatId);
  if (kind === "set" && convId) return { kind: "set", convId, name, ...(chatId ? { chatId } : {}) };
  return { kind: "chat", chatId: chatId || "me", name };
}
const isAi = (by: string) => /^AI\b/i.test(by);
const timeOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || 0 : 0);

/** The recent test chats, newest first. A gateway without `list` hides the section (null), quietly. */
export async function readRecentSandboxes() {
  if (!call) return;
  try {
    const b = await call("list", {});
    sandbox.recent = arr<Record<string, unknown>>(b.chats)
      .filter((c) => typeof c.sandboxId === "string" && c.sandboxId)
      .map((c) => {
        const source = sourceOf(c);
        const openedBy = str(c.openedBy) || "Lab";
        const lastBy = str(c.lastBy) || openedBy;
        return {
          sandboxId: str(c.sandboxId),
          name: source.kind === "maya" ? "Maya (test account)" : source.name,
          source,
          versionId: str(c.versionId) || "main",
          openedBy,
          lastBy,
          at: Math.max(timeOf(c.lastAt), timeOf(c.openedAt)),
          ai: isAi(openedBy) || isAi(lastBy),
          texts: num(c.testRows) ?? num(c.rows) ?? 0,
          running: !!c.running,
        };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    sandbox.recent = null;
  }
  emit();
}

/**
 * Open a test chat that already exists, by its id (`/lab?testchat=<id>`, or Recent test chats): shown as it stands
 * and followed live, whoever texts in it. `use` says who is in it where the gateway has it; `get` otherwise.
 */
export async function attachSandbox(sandboxId: string, versionId: string, recent?: SandboxRecent) {
  if (polling) clearTimeout(polling);
  polling = null;
  rawRows = [];
  Object.assign(sandbox, { id: sandboxId, linked: sandboxId, problem: null, shared: true, versionId: recent?.versionId ?? versionId, rows: [], writes: [], running: null, hot: null, fit: null, people: [], handles: {}, as: "", preview: null });
  if (recent) sandbox.source = recent.source;
  seenFor = null;
  if (!call) return run("get", {});
  sandbox.busy = true;
  emit();
  let used = false;
  try {
    const b = await call("use", { sandboxId });
    if (typeof b.sandboxId === "string" && b.sandboxId !== sandboxId) throw new Error("another chat");
    if (b.source && typeof b.source === "object") sandbox.source = sourceOf(b.source as Record<string, unknown>);
    if (typeof b.versionId === "string" && b.versionId) sandbox.versionId = b.versionId;
    take(b);
    used = Array.isArray(b.rows);
  } catch {
    /* a gateway without `use`: get reads it */
  }
  sandbox.busy = false;
  if (used) {
    sandbox.linked = null;
    emit();
    return poll();
  }
  await run("get", {});
  // Opened (rows came back) or not: a link that could not be opened says so, and keeps its id to try again.
  if (sandbox.problem === null) sandbox.linked = null;
  else if (sandbox.linked === sandboxId) sandbox.problem = `Couldn't open the linked test chat ${sandboxId}: ${sandbox.problem}`;
  emit();
}

/**
 * The test chat a link opens (`/lab?testchat=<id>`), read once as the Lab loads, before it rewrites its address. Links
 * written before the rename (Dev2, 2026-11-22: "sandbox" means a pull request's preview) say `?sandbox=<id>`.
 */
const fromUrl: string | null = (() => {
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("testchat") ?? q.get("sandbox");
    return v && /^[\w.:-]{1,128}$/.test(v) ? v : null;
  } catch {
    return null;
  }
})();
let urlTaken = false;
/** The link's test chat id, once: the dock opens it instead of a fresh one. */
export function takeUrlSandbox(): string | null {
  if (urlTaken) return null;
  urlTaken = true;
  return fromUrl;
}

/**
 * "Try from here" (Replay's, before Replay joined the Lab): a test chat over that chat with its real texts up to (not
 * including) the one picked, and that text waiting to be sent, as whoever sent it.
 */
export function tryFromHere(chatId: string, name: string, msgId: string, as: string, text: string, kind: "chat" | "shared" = "chat") {
  sandbox.draft = { as, text };
  // Opened before the canvas shows: the test chat mounting with that switch then finds a chat on its way and waits for
  // it, rather than opening one of its own over the whole chat.
  const p = openSandbox({ kind, chatId, name }, lab.cur.id, msgId);
  setLab({ mode: "lab", view: "canvas", sel: null });
  return p.then(() => {
    const name = sandbox.people.includes(as) ? as : Object.keys(sandbox.handles).find((n) => sandbox.handles[n] === as);
    if (name) sandbox.as = name;
    emit();
  });
}
export function takeDraft() {
  const d = sandbox.draft;
  sandbox.draft = null;
  return d;
}

/**
 * The Testing tab's "Try a text": the chat so far as a test chat on the version picked to run, and one more text from
 * one of its people, run in Tex's gateway on live models. Read only, like every test chat.
 */
export async function tryText(convId: string, name: string, versionId: string, who: string, text: string, group = false, pics: string[] = []) {
  let chatId: string | undefined;
  if (group) {
    // A group conversation runs in one of your group chats: its Tex notes read, its history the conversation's.
    if (!sandbox.chats.length) await readSandboxChats();
    chatId = sandbox.chats.find((c) => c.chatId !== "me")?.chatId;
    if (!chatId) {
      sandbox.problem = "A group conversation is tried in one of your group chats with Tex, and you aren't in one";
      emit();
      return;
    }
  }
  if (sandbox.id) await run("reset", {});
  await openSandbox({ kind: "set", convId, name, ...(chatId ? { chatId } : {}) }, versionId);
  if (!sandbox.id) return;
  sandbox.as = sandbox.people.includes(who) ? who : (sandbox.people[0] ?? who);
  await sendText(text, { pics });
}

/**
 * The Nightly page's Run now (Dev2, 2026-11-20: "okay, let's run it now"): the nightly graph on the version open in the
 * Lab, in a test chat of your own 1:1 with Tex, over a copy of your workspace. Opens that chat first when the dock shows
 * another; the run is a row in it, its steps on the card, and Tex's row says what About me became.
 */
export async function runNightlyNow(versionId: string, which: "dream" | "housekeeping" = "dream") {
  const own = sandbox.id !== null && !sandbox.shared && sandbox.source.kind === "chat" && sandbox.source.chatId === "me" && sandbox.versionId === versionId;
  if (!own) {
    await openSandbox({ kind: "chat", chatId: "me", name: "You and Tex" }, versionId);
    if (!sandbox.id) return;
  }
  await run("nightly", { run: which, versionId });
}

const asHandle = () => sandbox.handles[sandbox.as] ?? sandbox.as;
/** A test text, with up to six pictures and the text it replies to: a real Tex turn in the test chat. */
export const sendText = (text: string, extra: { pics?: string[]; replyTo?: string } = {}) =>
  run("send", { as: asHandle(), text, ...(extra.pics?.length ? { pics: extra.pics.slice(0, 6).map((url) => ({ url })) } : {}), ...(extra.replyTo ? { replyTo: extra.replyTo } : {}) });
/** A tapback on a text, as whoever the composer sends as: Tex sees it as it would a real one. */
export const reactTo = (msgId: string, emoji: string) => run("react", { as: asHandle(), msgId, emoji });

/** Whoever sent a text, as the gateway knows them: an edit or an unsend is only ever its sender's. */
const senderOf = (msgId: string) => {
  const who = sandbox.rows.find((r) => r.id === msgId)?.who ?? "";
  return sandbox.handles[who] ?? who;
};
/** An edit of a test text: the edit step runs as on a real iMessage edit, and a turn on the new words when they changed. */
export const editText = (msgId: string, text: string) => run("edit", { as: senderOf(msgId), msgId, text });
/** Undo Send on a test text: kept as taken back, with no turn, as production keeps one. */
export const unsendText = (msgId: string) => run("unsend", { as: senderOf(msgId), msgId });

export const retryText = (msgId: string) => run("retry", { msgId });
/**
 * Go back to a text: it and its reply kept, everything later dropped. A real text the chat started from can't be cut,
 * so the test chat opens again with the real texts up to the one after it.
 */
export function backTo(msgId: string) {
  const i = sandbox.rows.findIndex((r) => r.id === msgId);
  if (i < 0 || !sandbox.rows[i].prod) return run("back", { msgId });
  const next = sandbox.rows.slice(i + 1).find((r) => r.prod);
  return reopen(next?.id);
}
export const dropText = (msgId: string) => run("drop", { msgId });
function reopen(base?: string) {
  const { source, versionId } = sandbox;
  return (sandbox.id ? run("reset", {}) : Promise.resolve()).then(() => openSandbox(source, versionId, base));
}
/** Reset: the test chat deleted, and a fresh one over the same chat. */
export const resetSandbox = () => reopen();
/** Discard a try: the test chat deleted, nothing opened again. */
export const discardSandbox = () => (sandbox.id ? run("reset", {}) : Promise.resolve());
export function sendAs(who: string) {
  sandbox.as = who;
  emit();
}

/** Words for a failed test chat call: the gateway's message, never a bare code like "server_error" (Dev2, 2026-11-16). */
export function failureWords(status: number, b: Record<string, unknown> | null): string {
  const message = str(b?.message);
  if (message) return message;
  const error = str(b?.error);
  if (error && /\s/.test(error)) return error;
  return status === 403 ? "Only Tex developers can use the test chat" : status === 404 ? "The test chat isn't live yet" : "The test chat hit a problem on the server and couldn't finish. Try again, or pick another chat.";
}

/** The gateway's route as a `SandboxCall`: the person's own console grant, once more on a 401. */
export function gatewaySandbox(endpoint: string, token: (refresh: boolean | { rejected: string }) => Promise<string>, doFetch: typeof fetch = (...a) => fetch(...a)): SandboxCall | null {
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return null;
  }
  return async (op, body) => {
    const go = async (t: string) => doFetch(origin + "/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ op, ...body }) });
    const t = await token(false);
    let r = await go(t);
    if (r.status === 401) r = await go(await token({ rejected: t }));
    const b = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (r.status !== 200 || !b) throw new Error(failureWords(r.status, b));
    return b;
  };
}

/** For tests: back to an empty test chat. */
export function resetSandboxState() {
  Object.assign(sandbox, { id: null, source: { kind: "maya" }, versionId: "main", people: [], handles: {}, as: "", rows: [], writes: [], running: null, hot: null, busy: false, problem: null, linked: null, chats: [], sharedChats: [], sets: [], draft: null, shared: false, recent: null, fit: null, line: null, code: "main", preview: null });
  seenFor = null;
  seen = new Set();
  if (polling) clearTimeout(polling);
  polling = null;
  emit();
}
