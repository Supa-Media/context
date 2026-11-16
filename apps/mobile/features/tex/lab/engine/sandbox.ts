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
import { lab, set as setLab } from "./state";

export type SandboxSource = { kind: "maya" } | { kind: "chat"; chatId: string; name: string } | { kind: "set"; convId: string; name: string; chatId?: string };
export type SandboxRow = {
  id: string;
  who: string;
  text: string;
  at?: number;
  prod?: boolean;
  quiet?: boolean;
  tex?: boolean;
  steps?: StepCell[];
  /** Pictures sent with the text (https only), the text it replies to, and whether it was edited. */
  pics?: string[];
  replyTo?: string;
  edited?: boolean;
  /** Tapbacks on this text, each run as a Tex turn of its own. */
  reactions?: Array<{ who: string; emoji: string }>;
  /** A row that is a tapback or an edit on another text, not a text of its own. */
  kind?: "reaction" | "edit";
};
/** The tapbacks iMessage has, in its order. */
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
export type SandboxWrite = { kind: string; summary: string; by?: string };
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
  /** The chats you may open a test chat over (your 1:1 and your group chats). */
  chats: Array<{ chatId: string; name: string; kind?: "dm" | "group"; people?: number }>;
  /** The Training and Dev conversations a test chat may start from (the gateway's `sets`; never the Test set). */
  sets: Array<{ id: string; title: string; set: "training" | "dev"; group: boolean; texts: number }>;
  /** A text waiting in the composer: Replay's "Try from here" puts the text it tries from there. */
  draft: { as: string; text: string } | null;
};

export type SandboxOp = "chats" | "sets" | "open" | "send" | "react" | "retry" | "back" | "drop" | "reset" | "get";
export type SandboxCall = (op: SandboxOp, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const sandbox: SandboxState = { id: null, source: { kind: "maya" }, versionId: "main", people: [], handles: {}, as: "", rows: [], writes: [], running: null, hot: null, busy: false, problem: null, chats: [], sets: [], draft: null };

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
export function setSandboxCall(c: SandboxCall | null) {
  call = c;
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
    steps: arr<Record<string, unknown>>(r.steps).map((x) => ({ node: str(x.node), out: str(x.out), ms: num(x.ms), ok: x.ok === false ? false : true })),
    ...(Array.isArray(r.pics) ? { pics: arr<unknown>(r.pics).map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? str((p as Record<string, unknown>).url) : "")).filter((u) => u.startsWith("https://")) } : {}),
    ...(typeof r.replyTo === "string" && r.replyTo ? { replyTo: r.replyTo } : {}),
    ...(r.edited === true ? { edited: true } : {}),
    ...(Array.isArray(r.reactions) ? { reactions: arr<Record<string, unknown>>(r.reactions).map((x) => ({ who: str(x.who), emoji: str(x.emoji) })).filter((x) => x.emoji) } : {}),
    ...(r.kind === "reaction" || r.kind === "edit" ? { kind: r.kind } : {}),
  };
}

function take(b: Record<string, unknown>) {
  if (typeof b.sandboxId === "string") sandbox.id = b.sandboxId;
  if (Array.isArray(b.people)) {
    // `{handle, name}` each, or a bare name.
    const ps = arr<unknown>(b.people).map((x) => (typeof x === "string" ? { handle: x, name: x } : x && typeof x === "object" ? { handle: str((x as Record<string, unknown>).handle), name: str((x as Record<string, unknown>).name) } : null)).filter((x): x is { handle: string; name: string } => !!x && !!(x.name || x.handle));
    sandbox.people = ps.map((x) => x.name || x.handle);
    sandbox.handles = Object.fromEntries(ps.map((x) => [x.name || x.handle, x.handle]));
  }
  if (Array.isArray(b.rows)) {
    const raw = arr<Record<string, unknown>>(b.rows);
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
  }
  if (Array.isArray(b.writes)) sandbox.writes = arr<Record<string, unknown>>(b.writes).map((w) => ({ kind: str(w.kind), summary: str(w.summary), by: str(w.by) || undefined }));
  sandbox.running = typeof b.running === "string" ? b.running : b.running && typeof b.running === "object" ? str((b.running as Record<string, unknown>).msgId) || null : null;
  sandbox.hot = b.running && typeof b.running === "object" ? str((b.running as Record<string, unknown>).node) || null : typeof b.hot === "string" ? b.hot : null;
  if (!sandbox.as || !sandbox.people.includes(sandbox.as)) sandbox.as = sandbox.people[0] || "";
}

let polling: ReturnType<typeof setTimeout> | null = null;
const POLL_MS = 700;
function poll() {
  if (polling) clearTimeout(polling);
  polling = null;
  if (!sandbox.running || !sandbox.id) return;
  polling = setTimeout(() => void run("get", {}, false), POLL_MS);
}

async function run(op: SandboxOp, body: Record<string, unknown>, busy = true) {
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
    if (op === "reset") {
      // Reset deletes the test chat.
      Object.assign(sandbox, { id: null, rows: [], writes: [], running: null, hot: null });
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
  } catch {
    /* Maya stays */
  }
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
  sandbox.source = source;
  sandbox.versionId = versionId;
  sandbox.id = null;
  sandbox.rows = [];
  sandbox.writes = [];
  sandbox.running = null;
  sandbox.hot = null;
  return run("open", { source: source.kind, ...(source.kind === "chat" ? { chatId: source.chatId } : source.kind === "set" ? { convId: source.convId, ...(source.chatId ? { chatId: source.chatId } : {}) } : {}), versionId, ...(base ? { base } : {}) });
}
/**
 * Replay's "Try from here": the Lab, a test chat over that chat with its real texts up to (not including) the one
 * picked, and that text waiting to be sent, as whoever sent it.
 */
export function tryFromHere(chatId: string, name: string, msgId: string, as: string, text: string) {
  sandbox.draft = { as, text };
  setLab({ mode: "lab", view: "canvas", sel: null });
  const p = openSandbox({ kind: "chat", chatId, name }, lab.cur.id, msgId);
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
export async function tryText(convId: string, name: string, versionId: string, who: string, text: string, group = false) {
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
  await sendText(text);
}

const asHandle = () => sandbox.handles[sandbox.as] ?? sandbox.as;
/** A test text, with up to six pictures and the text it replies to: a real Tex turn in the test chat. */
export const sendText = (text: string, extra: { pics?: string[]; replyTo?: string } = {}) =>
  run("send", { as: asHandle(), text, ...(extra.pics?.length ? { pics: extra.pics.slice(0, 6).map((url) => ({ url })) } : {}), ...(extra.replyTo ? { replyTo: extra.replyTo } : {}) });
/** A tapback on a text, as whoever the composer sends as: Tex sees it as it would a real one. */
export const reactTo = (msgId: string, emoji: string) => run("react", { as: asHandle(), msgId, emoji });

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
    if (r.status !== 200 || !b) throw new Error(str(b?.error) || (r.status === 403 ? "Only Tex developers can use the test chat" : r.status === 404 ? "The test chat isn't live yet" : "The test chat didn't answer"));
    return b;
  };
}

/** For tests: back to an empty test chat. */
export function resetSandboxState() {
  Object.assign(sandbox, { id: null, source: { kind: "maya" }, versionId: "main", people: [], handles: {}, as: "", rows: [], writes: [], running: null, hot: null, busy: false, problem: null, chats: [], sets: [], draft: null });
  if (polling) clearTimeout(polling);
  polling = null;
  emit();
}
