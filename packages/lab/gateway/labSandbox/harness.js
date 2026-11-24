/**
 * ONE TEST TEXT'S GATE IN A LAB TEST CHAT (Dev2, 2026-11-16: "send test messages to see how the new architecture
 * responds ... have all the changes sandboxed so it doesn't actually affect production"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * The text runs as a real one does (`chatRun.js`): through the chat object, then `handleAgent` on the session a real
 * texted turn in that chat would run on, with the draft's wiring. What it runs on is not: its env is `sandboxEnvOf`,
 * its objects answer through `wire.js`, its control-plane calls through `policy.js` `controlPlaneAnswer` and its tools
 * through `toolAnswer`. The gate below is what those ask, the only thing that knows which text the turn is for, and
 * where every step the text causes is kept as it runs (`steps.js`).
 */

import { TEX_CONFIG, withDraft } from "../fromGateway/agent_texConfig.js";
import { callSandbox } from "./object.js";
import { READ_TOOLS, toolSummary } from "../fromGateway/labSandbox_policy.js";
import { fitSteps, stepBook } from "./steps.js";
import { askOf, SANDBOX_EVENT_CHAT } from "./inbound.js";

export { SANDBOX_EVENT_CHAT };
/** A turn that has not answered by then is stopped and said so on its row. */
export const TURN_LIMIT_MS = 4 * 60_000;
/**
 * A running mark nobody has refreshed for this long is a turn that died (`object.js` `claim`, `route.js` `view`). A live
 * turn refreshes it with every step, and a job between passes at least every `jobs.js` `BEAT_MS`.
 */
export const RUNNING_STALE_MS = TURN_LIMIT_MS + 2 * 60_000;
/** The Lab's row keeps this much of a node's output, for a step read from the ledger (`stepsOf`). */
const OUT_CHARS = 600;

let counter = 0;
/** An event id as the log wants it: `<13-digit ms>-<6 digits>`. */
export function eventId(at) {
  counter = (counter + 1) % 1_000_000;
  return `${String(at).padStart(13, "0")}-${String(counter).padStart(6, "0")}`;
}


/** A node's output as the Lab's row shows it: its JSON, cut. */
function outOf(value) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > OUT_CHARS ? `${text.slice(0, OUT_CHARS)}…` : text;
}

/** The steps a text's turn ran, from the node entries its ledger kept (`ledger.js` `nodeEntry`), in order. */
export function stepsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.kind === "step" && entry.step === "node" && typeof entry.name === "string")
    .map((entry) => ({ node: entry.name, out: outOf(entry.output), ms: Number.isFinite(entry.ms) ? entry.ms : 0, ok: entry.ok !== false }));
}

/**
 * The gate one test text's turn carries (`policy.js` `LAB_SANDBOX_KEY`). `about` is the test chat (`route.js` `open`):
 * `owner` the real object's owner name the test chat's ledger stands in for (`person:<id>` or `chat:<key>`), and
 * `ledgerChat` that ledger's chat. `arrivedAt` is when the text was sent (its steps' `at` count from there). Every call
 * goes to the test chat's object; `flush()` waits for the ones not awaited. Its methods are closures: the runner and the
 * fences call them unbound.
 */
export function sandboxGate(stub, about, rowId, { config = null, arrivedAt = Date.now(), now = Date.now } = {}) {
  const pending = [];
  // Once the test chat answers "gone" (Reset while this turn ran), the turn is cancelled: everything it asks after is
  // refused there, and what can stop (its jobs, `jobs.js`) stops.
  let cancelled = false;
  const call = async (op, fields) => {
    try {
      return await callSandbox(stub, op, fields);
    } catch (error) {
      if (error?.status === 410) cancelled = true;
      throw error;
    }
  };
  const later = (work) => void pending.push(Promise.resolve(work).catch(() => {}));
  // A made-up chat opened before its owner was its key's (`world.js` `worldAbout`) stands in for its key's object too.
  const owner = about?.world && typeof about?.chatKey === "string" ? `chat:${about.chatKey}` : about?.owner;
  const ours = (obj) => typeof obj === "string" && typeof owner === "string" && obj.endsWith(`#${owner}`);
  const ops = new Set();
  // The running row as it stands: every step so far (`steps.js`), the running ones with no `ms` yet. One post at a
  // time; a change while one is out is posted after it, so the Lab never reads an older view last.
  let posting = null;
  let dirty = false;
  const post = () => {
    dirty = true;
    if (posting !== null) return;
    posting = (async () => {
      while (dirty) {
        dirty = false;
        const steps = book.view();
        const node = [...steps].reverse().find((step) => step.ms === undefined)?.node ?? steps.at(-1)?.node ?? null;
        await call("beat", { msgId: rowId, node, steps: fitSteps(steps) }).catch(() => {});
      }
      posting = null;
    })();
    later(posting);
  };
  const book = stepBook({ rowId, arrivedAt, config: config ? withDraft(TEX_CONFIG, config) : TEX_CONFIG, now, onChange: post });
  /** A write as the Lab lists it (`object.js` gives it its `id`): `kind`, `title`, by this text, when. */
  const keep = (write) => call("write.add", { write: { ...write, kind: String(write?.kind ?? "other").toLowerCase().slice(0, 40), title: String(write?.title ?? write?.summary ?? "").slice(0, 200), summary: String(write?.summary ?? write?.title ?? "").slice(0, 200), by: rowId, at: now() } });
  /** A tool call the turn logged (`ledger.js` `toolEntry`), on the model step that made it. */
  const logged = (entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.kind !== "tool" || typeof entry.name !== "string") continue;
      book.call({ tool: entry.name, kind: READ_TOOLS.has(entry.name) ? "read" : "write", ms: entry.ms, d: `${toolSummary(entry.name, entry.args)}${entry.ok === false ? " (failed)" : ""}`, think: entry.thinking });
    }
  };
  return {
    get cancelled() {
      return cancelled;
    },
    config,
    ops,
    about,
    rowId,
    book,
    call,
    record(write) {
      later(keep({ kind: write?.kind, summary: write?.summary, ...(write?.tool ? { tool: write.tool } : {}) }));
    },
    /** A write the test chat did itself (`sandboxTools.js`), with what the Lab shows of it: its body, address, to. */
    async write(write) {
      return (await keep(write)).id ?? null;
    },
    usage: (spent) => book.usage(spent),
    /** A chat object step, as it finished (`chatRun.js`). */
    worker: (step, at) => book.worker(step, at),
    onStart: (run) => book.runStarted(run),
    saw(op) {
      ops.add(op);
    },
    async kvGet(obj, key) {
      return (await call("kv.get", { obj, key })).found ?? null;
    },
    async kvPut(obj, key, record) {
      await call("kv.put", { obj, key, ...record, by: rowId });
    },
    async kvList(obj, prefix) {
      return (await call("kv.list", { obj, prefix })).keys ?? [];
    },
    ledger(obj, chat) {
      if (!ours(obj) || chat !== about.ledgerChat) return null;
      return {
        read: (options) => call("ledger.read", { chat, options }),
        oldest: async () => (await call("ledger.oldest", { chat })).oldest ?? null,
        append: (entries) => {
          logged(entries);
          return call("ledger.append", { entries, by: rowId });
        },
      };
    },
    /** Each node as it finishes: the Lab's running row gets it at once, with what it gave, not when the turn ends. */
    onNode: (run) => book.runEnded(run),
    show: post,
    flush: async () => {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    },
  };
}

/**
 * The `/agent` body a real text would send (`packages/tex/worker/clients.ts` `askAgent` for a 1:1, `groupModelTurn.ts` for a
 * group): the question, or `ask` (`inbound.js` `askOf`: a reply's `quoted`/`replied`, a tapback's `tapback`), the
 * pictures as `attachments`, a 1:1's noted tapbacks as `reacted`, and a group's chat lines (`chat`, each `{ who, text }`;
 * the rows' people when not given).
 */
export function turnBody({ about, text, ask = null, as, eid, turn, rows, chat = null, attachments = [], reacted = [] }) {
  const asked = ask ?? { question: text };
  const question = String(asked.question ?? "");
  const reply = { ...(asked.quoted ? { quoted: asked.quoted } : asked.replied ? { replied: true } : {}), ...(asked.quoted && asked.tapback ? { tapback: asked.tapback } : {}) };
  const files = attachments.length > 0 ? { attachments } : {};
  const base = { question, covers: [eid], chat: SANDBOX_EVENT_CHAT, turn, arrivedAt: Date.now(), ...(about.timeZone ? { timeZone: about.timeZone } : {}) };
  if (about.kind !== "group") return { ...base, conversation: "texts", ...files, ...reply, ...(reacted.length > 0 ? { reacted } : {}) };
  const handles = (about.people ?? []).map((person) => person.handle).filter((handle) => typeof handle === "string" && /^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(handle));
  const from = handles.includes(as) ? as : "";
  const lines = chat ?? (rows ?? []).filter((row) => row.who !== "Tex").slice(-30).map((row) => ({ who: row.who, text: String(row.text ?? "") }));
  const said = lines.map((line) => ({ from: handles.includes(line.who) ? line.who : "", text: line.text }));
  return {
    ...base,
    group: {
      key: about.chatKey,
      members: about.members,
      from,
      people: handles,
      ...(from === "" ? { guests: [String(as).slice(0, 40)], asker: String(as).slice(0, 40) } : {}),
      chat: said,
      tagged: /@tex\b/i.test(question),
    },
    ...files,
    ...reply,
  };
}

/** One row's whole `/agent` body: what it asks (`askOf`, pictures downloaded with `fetch`) in the shape `turnBody` gives. */
export async function turnRequestBody({ about, row, rows, turn, fetch, images }) {
  const { ask, attachments, reacted, chat } = await askOf({ about, row, rows, ...(fetch ? { fetch } : {}), images });
  return turnBody({ about, ask, as: row.who, eid: row.eid, turn, rows, chat: about.kind === "group" ? chat : null, attachments, reacted });
}
