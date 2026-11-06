/**
 * The Tex page's records, rebuilt from the chat's one log (decided by the
 * owner, 2026-11-02: one JSON log per chat in its Tex object, every view
 * rebuilt from it; `docs/decisions/texting-assistant/chat-ledger.md`). Nothing
 * here is kept: each read pages back through the log.
 *
 * - `thinking`: one item per turn, newest first: `{id, at, who, said, thought,
 *   did, reply, ms}`. The turn's entries share its `turn`; what it answered is
 *   the person's texts its own texts name in `covers`.
 * - `advisor`: each `advisor` entry, and each `ask_advisor` tool call.
 * - `mailcheck`: each `mail_check` entry; the checker's `yes` is "sent", `no`
 *   is "stopped", anything else is "waiting" for the person's yes. A check a
 *   later entry names in `ref` (the person settled it) shows as that entry.
 *
 * A cursor is the log's `seq` to read on before. `count` is how many are at
 * or after `since` (the viewer's start of today). Pure over a ledger with the
 * shape of `texLedger` (`read(chat, options)`), given as a function because
 * the object builds its log beside this.
 */

export const ADVISOR_TOOL = "ask_advisor";
/** The most log entries one view reads back. */
export const VIEW_READ = 2_000;
const THOUGHT_CHARS = 600;
const WORDS_CHARS = 2_000;
const TURN_KINDS = ["text", "thinking", "said", "tool", "reply", "advisor", "mail_check", "job"];
const VERDICT = { yes: "sent", sent: "sent", no: "stopped", stopped: "stopped" };
const GROUP_KEY = /^[0-9a-f]{64}$/;

/** A chat as the page's jobs name it (`{phone}` or `{groupKey}`), as its log does. */
export function logChatOf(jobsChat) {
  if (typeof jobsChat?.groupKey === "string" && GROUP_KEY.test(jobsChat.groupKey)) return jobsChat.groupKey;
  return "texts";
}

const cut = (text, max) => {
  const words = typeof text === "string" ? text.trim() : "";
  return words.length > max ? `${words.slice(0, max - 1)}…` : words;
};
const cursorOf = (value) => {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : Number.MAX_SAFE_INTEGER;
};
const sizeOf = (limit) => Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 20));
const sinceOf = (since) => (Number.isFinite(since) ? since : 0);
const label = (name) => String(name ?? "").replace(/_/g, " ").trim() || "a tool";

/** Who a text was from, as the page names them: the viewer's own chat with Tex is "You". */
function whoOf(entry, chat) {
  const from = entry?.from ?? {};
  if (from.kind === "tex") return "Tex";
  if (chat === "texts") return "You";
  return typeof from.name === "string" && from.name !== "" ? from.name.split(" ")[0] : "Someone";
}

function verdictOf(raw) {
  return VERDICT[raw] ?? "waiting";
}

/** A check a later entry settles (its `ref`) is shown only as that later entry: the log is appended to, never rewritten (`agent/workEntries.js`). */
function latestChecks(entries) {
  const settled = new Set(entries.filter((entry) => entry.kind === "mail_check" && typeof entry.ref === "string").map((entry) => entry.ref));
  return settled.size === 0 ? entries : entries.filter((entry) => entry.kind !== "mail_check" || !settled.has(entry.id));
}

function mailItem(entry) {
  return {
    id: entry.id,
    at: entry.at,
    to: String(entry.to ?? ""),
    subject: String(entry.subject ?? ""),
    verdict: verdictOf(entry.verdict),
    why: String(entry.why ?? ""),
    from: typeof entry.from === "string" && entry.from !== "" ? entry.from : entry.job ? "a job" : "your texts",
  };
}

function advisorItem(entry, said) {
  if (entry.kind === "tool") {
    return {
      id: entry.id,
      at: entry.at,
      question: cut(entry.args?.question ?? said ?? "", WORDS_CHARS),
      answer: cut(entry.result ?? (entry.withheld ? "" : entry.reason ?? ""), WORDS_CHARS),
      read: "Read the whole turn",
      ms: entry.ms ?? 0,
    };
  }
  return {
    id: entry.id,
    at: entry.at,
    ...(typeof entry.jobTitle === "string" ? { job: entry.jobTitle } : {}),
    question: cut(entry.question, WORDS_CHARS),
    answer: cut(entry.answer, WORDS_CHARS),
    read: Number.isSafeInteger(entry.steps) ? `Read the job so far · ${entry.steps} steps` : "Read the whole turn",
    ms: entry.ms ?? 0,
  };
}

/** The person's texts just before `seq` (`entries` newest first) back to the last thing Tex did, oldest first. */
function unclaimedBefore(entries, seq) {
  const found = [];
  for (const entry of entries) {
    if (entry.seq >= seq) continue;
    if (entry.kind !== "text" || entry.from?.kind === "tex" || typeof entry.turn === "string") break;
    found.push(entry);
  }
  return found.reverse();
}

/**
 * The turns among `entries` (newest first, as the log reads back with
 * `before`), newest first, each with the texts it answered.
 */
function turnsOf(entries, replies, chat) {
  const texts = new Map();
  const turns = new Map();
  for (const entry of entries) {
    // Newest first: an event written again (a voice message once heard, `agent/heardWords.js`) is shown by its newest entry.
    if (entry.kind === "text" && entry.from?.kind !== "tex" && typeof entry.eid === "string" && !texts.has(entry.eid)) texts.set(entry.eid, entry);
    if (typeof entry.turn !== "string" || entry.turn === "") continue;
    if (!turns.has(entry.turn)) turns.set(entry.turn, []);
    turns.get(entry.turn).push(entry);
  }
  const out = [];
  for (const [turn, list] of turns) {
    const oldest = [...list].reverse();
    const named = [...new Set(oldest.flatMap((entry) => (Array.isArray(entry.covers) ? entry.covers : [])))].map((eid) => texts.get(eid)).filter(Boolean);
    // A turn that sent nothing names nothing it answered: it read the texts just before it no other turn answered.
    const covered = named.length > 0 ? named : unclaimedBefore(entries, oldest[0].seq);
    const reply = replies.get(turn) ?? null;
    const did = [];
    for (const entry of oldest) {
      if (entry.kind === "tool" && entry.name === ADVISOR_TOOL) did.push({ kind: "advisor", label: "Asked the advisor", ref: entry.id });
      else if (entry.kind === "tool") did.push({ kind: "tool", label: label(entry.name) });
      else if (entry.kind === "advisor") did.push({ kind: "advisor", label: "Asked the advisor", ref: entry.id });
      else if (entry.kind === "mail_check") did.push({ kind: "mailcheck", label: `Checked an email to ${String(entry.to ?? "someone")}`, ref: entry.id });
      else if (entry.kind === "job") did.push({ kind: "job", label: String(entry.title ?? "Started a job"), ...(typeof entry.job === "string" ? { ref: entry.job } : {}) });
    }
    const first = Math.min(...[...list, ...covered].map((entry) => entry.at));
    const last = Math.max(...list.map((entry) => entry.at));
    out.push({
      id: turn,
      seq: Math.min(...list.map((entry) => entry.seq)),
      at: first,
      who: covered.length > 0 ? whoOf(covered[0], chat) : chat === "texts" ? "You" : "Someone",
      said: cut(covered.map((entry) => entry.text).join("\n"), WORDS_CHARS),
      thought: cut(oldest.filter((entry) => entry.kind === "thinking").map((entry) => entry.text).join(" "), THOUGHT_CHARS),
      did,
      reply: reply && typeof reply.text === "string" && reply.text !== "" ? reply.text : null,
      ms: Number.isFinite(reply?.ms) ? reply.ms : Math.max(0, last - first),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The page's records over a chat's log.
 *
 * @param {() => ({read: (chat: string, options: object) => {entries: object[]}} | null | undefined)} ledgerOf
 */
export function pageViews(ledgerOf) {
  const read = (chat, options) => {
    const ledger = ledgerOf();
    if (!ledger || typeof chat !== "string") return [];
    return ledger.read(chat, options)?.entries ?? [];
  };

  const thinking = (chat, { limit, cursor, since }) => {
    const before = cursorOf(cursor);
    const entries = read(chat, { before, kinds: TURN_KINDS, limit: VIEW_READ, slim: true });
    // A reply's words are left out of a slim read; read them alone.
    const replies = new Map(read(chat, { before, kinds: ["reply"], limit: VIEW_READ }).map((entry) => [entry.turn, entry]));
    const turns = turnsOf(entries, replies, chat);
    const size = sizeOf(limit);
    const page = turns.slice(0, size);
    const more = turns.length > size;
    return {
      items: page.map(({ seq: _seq, ...turn }) => turn),
      count: turns.filter((turn) => turn.at >= sinceOf(since)).length,
      ...(more && page.length > 0 ? { cursor: String(Math.min(...page.map((turn) => turn.seq))) } : {}),
    };
  };

  const entriesView = (chat, kinds, { limit, cursor, since }, item) => {
    const before = cursorOf(cursor);
    // Slim: a tool's result is read only for the asks shown, one at a time.
    const entries = read(chat, { before, kinds, limit: VIEW_READ, slim: true });
    const wanted = latestChecks(entries).filter((entry) => entry.kind !== "tool" || entry.name === ADVISOR_TOOL);
    const size = sizeOf(limit);
    const page = wanted.slice(0, size).map((entry) => (entry.kind === "tool" ? (read(chat, { before: entry.seq + 1, kinds: ["tool"], limit: 1 })[0] ?? entry) : entry));
    const turnSaid = page.some((entry) => entry.kind === "tool") ? saidByTurn(chat, before) : new Map();
    return {
      items: page.map((entry) => item(entry, turnSaid.get(entry.turn))),
      count: wanted.filter((entry) => entry.at >= sinceOf(since)).length,
      ...(wanted.length > size ? { cursor: String(page.at(-1).seq) } : {}),
    };
  };

  /** What each turn answered, for an advisor ask that sent no question of its own. */
  const saidByTurn = (chat, before) => {
    const said = new Map();
    for (const turn of turnsOf(read(chat, { before, kinds: ["text"], limit: VIEW_READ, slim: true }), new Map(), chat)) said.set(turn.id, turn.said);
    return said;
  };

  return {
    /** One page of a kind's items, newest first. */
    list(kind, { chat = "texts", limit, cursor, since } = {}) {
      if (kind === "thinking") return thinking(chat, { limit, cursor, since });
      if (kind === "advisor") return entriesView(chat, ["advisor", "tool"], { limit, cursor, since }, advisorItem);
      if (kind === "mailcheck") return entriesView(chat, ["mail_check"], { limit, cursor, since }, mailItem);
      return { items: [], count: 0 };
    },

    /** How many emails wait for the person's yes, from the last day. */
    waiting(chat = "texts", { now = Date.now() } = {}) {
      const day = now - 24 * 3_600_000;
      return latestChecks(read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["mail_check"], limit: VIEW_READ })).filter((entry) => entry.at >= day && verdictOf(entry.verdict) === "waiting").length;
    },
  };
}

/** The page's sections a log append changes. */
export function sectionsForKinds(kinds) {
  const sections = new Set();
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    if (["text", "thinking", "said", "tool", "reply", "job"].includes(kind)) sections.add("thinking");
    if (kind === "advisor" || kind === "tool") sections.add("advisor");
    if (kind === "mail_check") sections.add("mailcheck");
  }
  // Every append is a new line in the chat's history, which an open history view reads again on it
  // (Dev, 2026-11-03: "this page doesn't seem to realtime update").
  if ((Array.isArray(kinds) ? kinds : []).length > 0) sections.add("behind");
  return [...sections];
}
