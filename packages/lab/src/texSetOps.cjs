/**
 * SMALL EDITS TO ONE TEST CONVERSATION (Dev2, 2026-11-15: "make sure that through the MCP it's easy for an agent to
 * see and modify and change training, dev sets ... and the different properties"; prototype
 * https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K, the Lab's Testing tab).
 *
 * A conversation is `texSets.cjs`'s shape. The Lab's Testing tab, the control plane and the MCP's `tex_dev` change one
 * with the same edits, so a person in the Lab and an agent over the MCP can work on one conversation at once:
 *
 *   { op: "title",   value }                         the chat's title
 *   { op: "kind",    value: "one" | "group" }        a 1:1 text or a group chat
 *   { op: "members", value: [names] }                who is in it (never Tex)
 *   { op: "set",     value: "training" | "dev" }     which set it is in (the whole conversation moves; the Test Set is
 *                                                    the eval service's, never written here)
 *   { op: "add",     msg: {...}, after? }            a message: after the message `after` names, first when `after`
 *                                                    is null, last when it is left out; a new speaker joins members
 *   { op: "edit",    msg, field, value }             one field of a message: who, text, kind, to, tex, pics (who "Tex"
 *                                                    makes it a Tex row and drops its labels, as the Lab's speaker
 *                                                    picker does; kind null makes it a plain text again; pics is
 *                                                    the pictures sent with it, [{ url, type?, name? }], null drops them)
 *   { op: "remove",  msg }                           a message
 *   { op: "move",    msg, before }                   a message, to just before the message `before` names (null: last)
 *   { op: "label",   msg, node, value }              a node's whole label on a person's message (null drops it)
 *   { op: "field",   msg, node, field, value }       one field of that label: an output field, "any", must / never
 *                                                    lines, run ("must" | "must not"), star (true makes it a unit
 *                                                    test); null drops the field, and an empty label goes
 *   { op: "rec",     msg, node, value }              a node's recorded run on main on that message (null drops it)
 *   { op: "put",     convo }                         the whole conversation
 *
 * The Testing tab's index-based spellings land as the same edits (`canonical`): addMsg {at, msg}, editMsg {id,
 * patch}, removeMsg {id}, moveMsg {id, at}, label {id, node, label}. Making and deleting a whole conversation are the
 * store's (`new`, `delete` in `functions/texSets.ts`), not edits.
 *
 * Each edit names the pieces it touches (`keysOf`): the control plane refuses a batch made against an older revision
 * only when a revision since touched one of the same pieces, so two people labelling different cells both land
 * (`apps/convex/functions/texSets.ts`). Whether the result is a sound conversation is `texSets.cjs` `check`; an edit
 * here only refuses what cannot be applied at all. Nothing here reads a clock or a store.
 */
"use strict";

const { JOB_STATES, KINDS, TEX, TRIGGERS } = require("../../tex/src/texSets.cjs");

/** The sets a conversation may be in here: the Test Set lives only in the eval service. */
const OPEN_SETS = Object.freeze(["training", "dev"]);
const MSG_FIELDS = new Set(["who", "text", "kind", "to", "tex", "pics", "via", "state"]);
/** Pictures on one message: at most this many, each an https address (the Lab uploads to the control plane's files). */
const MAX_PICS = 6;
const PIC_TYPE = /^image\/(png|jpeg|gif|webp|heic|heif)$/;
const NODE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const MSG_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_OPS = 200;
const MAX_TEXT = 4000;
const SHORT = 60;

class OpError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpError";
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const short = (t, n = SHORT) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const show = (v) => (v === undefined || v === null ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));

function msgAt(c, id) {
  const i = c.msgs.findIndex((m) => m.id === id);
  if (i < 0) throw new OpError(`there is no message "${id}" in this chat`);
  return i;
}

/** A new message id, not yet in the chat: m<n> after the highest. */
function freshId(c) {
  let n = c.msgs.length + 1;
  const ids = new Set(c.msgs.map((m) => m.id));
  while (ids.has("m" + n)) n += 1;
  return "m" + n;
}

const joinMember = (c, who) => {
  if (who !== TEX && !c.members.includes(who)) c.members.push(who);
};

function text(v, what) {
  if (typeof v !== "string") throw new OpError(`${what} is text`);
  if (v.length > MAX_TEXT) throw new OpError(`${what} is longer than ${MAX_TEXT} characters`);
  return v;
}

/** A message's pictures as an edit hands them: a sound list, or an OpError. */
function pics(v) {
  if (!Array.isArray(v)) throw new OpError("pics is a list of { url, type?, name? }, or null to drop them");
  if (v.length > MAX_PICS) throw new OpError(`a message carries at most ${MAX_PICS} pictures`);
  return v.map((p) => {
    const url = p && typeof p === "object" ? p.url : undefined;
    if (typeof url !== "string" || !/^https:\/\/[^\s]{1,1000}$/.test(url)) throw new OpError("a picture's url is an https address");
    const out = { url };
    if (p.type !== undefined) {
      if (typeof p.type !== "string" || !PIC_TYPE.test(p.type)) throw new OpError("a picture's type is image/png, jpeg, gif, webp or heic");
      out.type = p.type;
    }
    if (p.name !== undefined) out.name = text(p.name, "a picture's name").slice(0, 120);
    return out;
  });
}

function makeTex(m) {
  m.tex = true;
  m.who = TEX;
  delete m.labels;
  delete m.rec;
  delete m.star;
}

/**
 * The Testing tab's own spellings of the same edits (index-based, a patch for a message), turned into the ones above
 * so both read the same: addMsg {at, msg}, editMsg {id, patch}, removeMsg {id}, moveMsg {id, at}, label {id, node, label}.
 * Answers a list: a patch of several fields is several edits.
 */
function canonical(c, op) {
  if (!op || typeof op !== "object") return [op];
  switch (op.op) {
    case "addMsg": {
      const at = Number.isInteger(op.at) ? Math.max(0, Math.min(op.at, c.msgs.length)) : c.msgs.length;
      return [{ op: "add", msg: op.msg, ...(at === c.msgs.length ? {} : { after: at === 0 ? null : c.msgs[at - 1].id }) }];
    }
    case "editMsg": {
      const patch = op.patch && typeof op.patch === "object" ? op.patch : {};
      const order = ["who", "tex", "text", "kind", "to"].filter((f) => f in patch);
      if (!order.length) throw new OpError("editMsg takes patch: { who?, tex?, text?, kind?, to? }");
      return order.map((field) => (field === "tex" && patch.tex !== true ? { op: "edit", msg: op.id, field: "who", value: patch.who ?? c.members[0] } : { op: "edit", msg: op.id, field, value: patch[field] }));
    }
    case "removeMsg":
      return [{ op: "remove", msg: op.id }];
    case "moveMsg": {
      const rest = c.msgs.filter((m) => m.id !== op.id);
      const at = Number.isInteger(op.at) ? Math.max(0, Math.min(op.at, rest.length)) : rest.length;
      return [{ op: "move", msg: op.id, before: at >= rest.length ? null : rest[at].id }];
    }
    case "label":
      return op.id !== undefined && op.msg === undefined ? [{ op: "label", msg: op.id, node: op.node, value: op.label === undefined ? op.value : op.label }] : [op];
    default:
      return [op];
  }
}

/** One edit applied to `c` (changed in place). */
function applyOne(c, op) {
  if (!op || typeof op !== "object") throw new OpError("an edit is an object with an op");
  switch (op.op) {
    case "title":
      c.title = text(op.value, "title").trim();
      if (!c.title) throw new OpError("a chat needs a title");
      return;
    case "kind":
      if (op.value !== "one" && op.value !== "group") throw new OpError('kind is "one" (a 1:1 text) or "group"');
      c.kind = op.value;
      return;
    case "members": {
      if (!Array.isArray(op.value) || op.value.some((x) => typeof x !== "string" || !x.trim())) throw new OpError("members is a list of names");
      if (op.value.includes(TEX)) throw new OpError("Tex is never a member; Tex rows say tex: true");
      c.members = [...new Set(op.value.map((x) => x.trim()))];
      return;
    }
    case "set":
      if (!OPEN_SETS.includes(op.value)) throw new OpError(op.value === "test" ? "the Test Set is people only and lives in the eval service: it is never written here" : 'set is "training" or "dev"');
      c.set = op.value;
      return;
    case "add": {
      const src = op.msg && typeof op.msg === "object" ? op.msg : null;
      if (!src) throw new OpError("add takes msg: { who, text, ... }");
      const m = clone(src);
      if (m.id === undefined) m.id = freshId(c);
      if (!MSG_ID.test(String(m.id))) throw new OpError(`message id "${m.id}" must be letters, digits, - or _`);
      if (c.msgs.some((x) => x.id === m.id)) throw new OpError(`there is already a message "${m.id}"`);
      if (typeof m.who !== "string" || !m.who.trim()) throw new OpError("a message needs who said it");
      text(m.text ?? "", "a message's text");
      if (m.pics !== undefined) m.pics = pics(m.pics);
      if (m.who === TEX || m.tex) makeTex(m);
      else if (m.via === undefined) joinMember(c, m.who); // a trigger row (check-in, routine) is never a member
      const at = op.after === undefined ? c.msgs.length : op.after === null ? 0 : msgAt(c, op.after) + 1;
      c.msgs.splice(at, 0, m);
      op.msg = m; // the id it got, for the change line and the answer
      return;
    }
    case "edit": {
      const m = c.msgs[msgAt(c, op.msg)];
      if (!MSG_FIELDS.has(op.field)) throw new OpError(`a message's fields are ${[...MSG_FIELDS].join(", ")}`);
      if (op.field === "who") {
        const who = text(op.value, "who").trim();
        if (!who) throw new OpError("a message needs who said it");
        if (who === TEX) makeTex(m);
        else {
          delete m.tex;
          m.who = who;
          joinMember(c, who);
        }
      } else if (op.field === "tex") {
        if (op.value === true) makeTex(m);
        else throw new OpError('to make a Tex row a person\'s, edit its who to their name');
      } else if (op.field === "via") {
        // A trigger row's input: its speaker is that input's name (`texSets.cjs` TRIGGERS); a person's row can't become one.
        if (!Object.hasOwn(TRIGGERS, op.value)) throw new OpError(`via is one of ${Object.keys(TRIGGERS).join(", ")}`);
        if (m.via === undefined) throw new OpError("only a trigger row (a check-in, a routine, a job's report) changes its input");
        m.via = op.value;
        m.who = TRIGGERS[op.value];
        if (op.value !== "job") delete m.state;
      } else if (op.field === "state") {
        if (m.via !== "job") throw new OpError("state is a job row's");
        if (op.value === null) delete m.state;
        else if (!JOB_STATES.includes(op.value)) throw new OpError(`state is one of ${JOB_STATES.join(", ")}`);
        else m.state = op.value;
      } else if (op.field === "text") m.text = text(op.value, "text");
      else if (op.field === "pics") {
        if (op.value === null || (Array.isArray(op.value) && !op.value.length)) delete m.pics;
        else m.pics = pics(op.value);
      }
      else if (op.field === "kind") {
        if (op.value === null || op.value === "text") {
          delete m.kind;
          delete m.to;
        } else if (!KINDS.includes(op.value)) throw new OpError(`kind is one of ${KINDS.join(", ")}, or null for a plain text`);
        else {
          m.kind = op.value;
          if (m.to === undefined) {
            const i = c.msgs.indexOf(m);
            if (i === 0) throw new OpError(`a ${op.value} points at an earlier message, and this is the first`);
            m.to = c.msgs[i - 1].id;
          }
          if (op.value === "delete") m.text = "";
        }
      } else {
        if (op.value === null) delete m.to;
        else {
          const j = msgAt(c, op.value);
          if (j >= c.msgs.indexOf(m)) throw new OpError("a reaction, reply, edit or delete points at an earlier message");
          m.to = op.value;
        }
      }
      return;
    }
    case "remove":
      c.msgs.splice(msgAt(c, op.msg), 1);
      return;
    case "move": {
      const i = msgAt(c, op.msg);
      if (op.before === op.msg) return; // before itself: where it already is
      if (op.before !== null && op.before !== undefined) msgAt(c, op.before);
      const [m] = c.msgs.splice(i, 1);
      const at = op.before === null || op.before === undefined ? c.msgs.length : msgAt(c, op.before);
      c.msgs.splice(at, 0, m);
      return;
    }
    case "label":
    case "field":
    case "rec": {
      const m = c.msgs[msgAt(c, op.msg)];
      if (!NODE.test(String(op.node))) throw new OpError("name the node by its config id (decide, fd, card …)");
      if (m.tex) throw new OpError("a Tex row is what Tex should have said: labels and recorded runs go on people's messages");
      const bag = op.op === "rec" ? "rec" : "labels";
      if (op.op === "field") {
        if (typeof op.field !== "string" || !op.field) throw new OpError("field names the label's field (an output field, must, never, run or star)");
        const l = { ...((m.labels || {})[op.node] || {}) };
        if (op.value === null || op.value === undefined || op.value === false || op.value === "" || op.value === "as main") delete l[op.field];
        else l[op.field] = clone(op.value);
        m.labels = { ...(m.labels || {}) };
        if (Object.keys(l).length) m.labels[op.node] = l;
        else delete m.labels[op.node];
        if (!Object.keys(m.labels).length) delete m.labels;
        return;
      }
      if (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value))) throw new OpError(`${op.op} takes value: an object, or null to drop it`);
      m[bag] = { ...(m[bag] || {}) };
      if (op.value === null || !Object.keys(op.value).length) delete m[bag][op.node];
      else m[bag][op.node] = clone(op.value);
      if (!Object.keys(m[bag]).length) delete m[bag];
      return;
    }
    case "put": {
      const n = op.convo;
      if (!n || typeof n !== "object" || !Array.isArray(n.msgs)) throw new OpError("put takes convo: the whole conversation");
      if (n.id !== c.id) throw new OpError(`put keeps the conversation's id (${c.id})`);
      if (!OPEN_SETS.includes(n.set)) throw new OpError("the Test Set is people only and lives in the eval service: it is never written here");
      for (const k of Object.keys(c)) delete c[k];
      Object.assign(c, clone(n));
      return;
    }
    default:
      throw new OpError(`there is no edit "${op.op}"; the edits are title, kind, members, set, add, edit, remove, move, label, field, rec, put`);
  }
}

/** The pieces an edit touches, for the conflict check. */
function keysOf(op) {
  switch (op?.op) {
    case "title":
    case "kind":
    case "members":
    case "set":
      return [op.op];
    case "add":
      return ["order", `m:${op.msg?.id ?? "new"}`];
    case "edit":
      return [`m:${op.msg}`];
    case "remove":
      return ["order", `m:${op.msg}`];
    case "move":
      return ["order"];
    case "label":
      return [`l:${op.msg}:${op.node}`];
    case "field":
      return [`l:${op.msg}:${op.node}:${op.field}`];
    case "rec":
      return [`r:${op.msg}:${op.node}`];
    default:
      return ["*"];
  }
}

/** Whether two pieces overlap: the same piece, the whole chat, or a message and anything on it. */
function overlaps(a, b) {
  if (a === "*" || b === "*" || a === b) return true;
  const msgOf = (k) => (/^[mlr]:/.test(k) ? k.split(":")[1] : null);
  const [ma, mb] = [msgOf(a), msgOf(b)];
  if (ma && ma === mb && (a.startsWith("m:") || b.startsWith("m:"))) return a.startsWith("m:") && b.startsWith("m:") ? a === b : true;
  if (a.startsWith("l:") && b.startsWith("l:")) return a.startsWith(b + ":") || b.startsWith(a + ":");
  return false;
}

/** The pieces in `mine` that one of `theirs` overlaps. */
function conflicts(mine, theirs) {
  return mine.filter((a) => theirs.some((b) => overlaps(a, b)));
}

/** One plain line for an edit, as the change list shows it (`full`: uncut). */
function describe(op, full = false) {
  const cut = (s) => (full ? s : short(s));
  switch (op?.op) {
    case "title":
      return cut(`renamed the chat "${op.value}"`);
    case "kind":
      return op.value === "one" ? "made it a 1:1 text" : "made it a group chat";
    case "members":
      return cut(`set members to ${(op.value || []).join(", ")}`);
    case "set":
      return `moved it to ${op.value === "dev" ? "Dev" : "Training"}`;
    case "add":
      return cut(`added ${op.msg?.id}: ${op.msg?.who}: ${op.msg?.text ?? ""}`);
    case "edit":
      if (op.field === "pics") return Array.isArray(op.value) && op.value.length ? `${op.msg}: ${op.value.length} picture${op.value.length === 1 ? "" : "s"}` : `${op.msg}: pictures removed`;
      return cut(`${op.msg} ${op.field} → ${show(op.value)}`);
    case "remove":
      return `removed ${op.msg}`;
    case "move":
      return `moved ${op.msg} ${op.before ? "before " + op.before : "to the end"}`;
    case "label":
      return cut(op.value === null ? `cleared ${op.node} on ${op.msg}` : `labelled ${op.node} on ${op.msg}: ${show(op.value)}`);
    case "field":
      return cut(op.field === "star" ? `${op.value ? "starred" : "unstarred"} ${op.node} on ${op.msg}` : `${op.node} on ${op.msg}: ${op.field} → ${show(op.value)}`);
    case "rec":
      return cut(op.value === null ? `dropped the recorded ${op.node} on ${op.msg}` : `recorded ${op.node} on ${op.msg}`);
    case "put":
      return "replaced the whole chat";
    default:
      return "an edit";
  }
}

/**
 * A batch of edits applied to a copy of `convo`: `{ convo, keys, said, full }`, or an OpError naming the edit that
 * could not be applied (nothing of the batch lands then).
 */
function applyOps(convo, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpError("ops is a list of edits");
  if (ops.length > MAX_OPS) throw new OpError(`at most ${MAX_OPS} edits at once`);
  const c = clone(convo);
  if (!Array.isArray(c.msgs)) c.msgs = [];
  if (!Array.isArray(c.members)) c.members = [];
  const keys = new Set();
  const said = [];
  const full = [];
  ops.forEach((raw, i) => {
    try {
      for (const op of canonical(c, clone(raw))) {
        applyOne(c, op);
        for (const k of keysOf(op)) keys.add(k);
        said.push(describe(op));
        full.push(describe(op, true));
      }
    } catch (error) {
      if (error instanceof OpError) throw new OpError(`edit ${i + 1} (${raw?.op ?? "?"}): ${error.message}`);
      throw error;
    }
  });
  return { convo: c, keys: [...keys], said, full };
}

/** One edit applied to a copy of `convo`: the new conversation (the Testing tab's single-edit form). */
const apply = (convo, op) => applyOps(convo, [op]).convo;

/** A new, empty conversation in a set. */
function blank({ id, title = "New chat", set = "dev", kind = "one", members = ["Jo"] }) {
  if (!OPEN_SETS.includes(set)) throw new OpError("the Test Set is people only and lives in the eval service: it is never written here");
  return { id, title, set, kind, members: [...members], msgs: [] };
}

// `checkPics`: the Lab test chats' pictures are checked as a Testing set message's are (`apps/mcp/src/labSandbox/inbound.js`).
module.exports = { OPEN_SETS, MAX_OPS, MAX_PICS, OpError, checkPics: pics, apply, applyOps, keysOf, conflicts, describe, blank };
