/**
 * `search` and `fetch`, translated into the one existing call each stands for.
 *
 * `translate.js` calls these with the top-level arguments of the v2 call:
 * `query` or `id`, the open `args` object, and `context` / `mailbox`. Those
 * two address the call and `translate.js` carries them; nothing returned here
 * contains them. Routing (`@name/path` sugar, `addressByPath`) is left to the
 * existing tool path, so a path that opens with a workspace name goes through
 * unchanged.
 *
 * ChatGPT's deep-research connector sends `search` and `fetch` with no `args`
 * and expects the JSON answers of `toolOpenAiSearch` / `toolOpenAiFetch`, so
 * that shape is kept for it. With `args` given, ChatGPT gets the same
 * translation as everybody else.
 */

import { splitMessageAnchor } from "../../search/commsIndex.js";
import { EMAIL_ID_PREFIX } from "../emailRead.js";
import { TEXTS_ID_PREFIX } from "../texts.js";
import { GOOGLE_CHAT_ID_PREFIX } from "../googleChatRead.js";
import { readableFileType } from "../readFile.js";
import { isSheetPath } from "../../sheets/csv.js";

const CHATGPT = /chatgpt|openai/i;

/** Longest caller text echoed back in a refusal. */
const ECHO_CAP = 40;

/** Named on the call, never inside `args`: routing reads only the top level. */
const ADDRESSING = ["context", "mailbox", "person_said"];

function isChatGpt(app) {
  return typeof app?.client === "string" && CHATGPT.test(app.client);
}

function echo(text) {
  return text.length > ECHO_CAP ? `${text.slice(0, ECHO_CAP)}…` : text;
}

/**
 * The open `args` as the caller sent them, with undefined values dropped.
 * `args` undefined (or null) means none was given; anything that is not a
 * plain object is refused.
 *
 * @returns {{args: object | undefined} | {error: string}}
 */
function openArgs(call) {
  const raw = call.args;
  if (raw === undefined || raw === null) return { args: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "args has to be an object of named options: call it again with args like { limit: 5 }, or without args." };
  }
  // An email search's address written as mailbox, a note-mail id everywhere else, was meant as the account
  // (2026-11-14: Tex was refused here, moved it to the top, and the search ran over every mailbox; `emailRead.js`).
  if (raw.email === true && raw.account === undefined && typeof raw.mailbox === "string" && raw.mailbox.includes("@")) {
    const { mailbox, ...rest } = raw;
    return openArgs({ args: { ...rest, account: mailbox } });
  }
  for (const key of ADDRESSING) {
    if (Object.hasOwn(raw, key)) {
      return { error: `${key} goes beside args, at the top of the call, not inside it: call it again with ${key} moved out of args.` };
    }
  }
  return { args: Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)) };
}

/**
 * One target. `fixed` is what the id or query itself names. `copy` lists the
 * args keys the target takes; they are passed under their own names. `consumed`
 * lists keys that choose the target and are not passed on. Any other key is
 * refused, with the keys this target takes.
 */
function target(label, a, { name, action, fixed = {}, copy = [], consumed = [], others = "" }) {
  const extra = Object.keys(a).filter((key) => !copy.includes(key) && !consumed.includes(key));
  if (extra.length > 0) {
    const takes = copy.length > 0 ? `args: ${copy.join(", ")}` : "no args";
    if (copy.length === 0) return { error: `${label} takes ${takes}${others}. Call it again without args; orient lists what each id takes.` };
    return { error: `${label} takes ${takes}${others}. Call it again with only those; orient lists what each id takes.` };
  }
  const out = { ...fixed };
  for (const key of copy) if (a[key] !== undefined) out[key] = a[key];
  return { name, arguments: out, action };
}

/**
 * Every other way a note id reads, said when a call to one names an arg none of them takes. The refusal used to
 * name only `mail`, so a job asking for `{ images: true }` was told a note takes nothing else, and guessed again
 * (the Nov Babies chat, 2026-11-12).
 */
const NOTE_READS =
  '; or, instead, one of: image: "<a picture\'s file name, as the note embeds it>" (one picture the note holds), ' +
  "related: true (with limit), lists: true, transcript, messages, activity";

/**
 * `note.md#Plan#Risks` as `{ path: "note.md", section: "Plan > Risks" }`, or null. Only after a `.md`, so a folder
 * or file whose own name holds a `#` is read as written.
 */
function headingFragment(id) {
  const at = id.indexOf(".md#");
  if (at === -1) return null;
  const segments = id
    .slice(at + 4)
    .split("#")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (!segments.length) return null;
  return { path: id.slice(0, at + 3), section: segments.map((segment) => segment.replace(/>/g, "\\>")).join(" > ") };
}

/** `search` in the v2 shape. */
export function translateSearch(call, app = {}) {
  const open = openArgs(call);
  if (open.error) return { error: open.error };
  if (isChatGpt(app) && open.args === undefined) {
    return { name: "search", arguments: { query: call.query }, action: "notes" };
  }
  // Their texts, from the Mac's backup (`texts.js`).
  if (open.args?.texts === true) {
    return target("search", open.args, {
      name: "search_texts",
      action: "texts",
      fixed: typeof call.query === "string" && call.query.trim() !== "" ? { query: call.query } : {},
      copy: ["with", "since", "limit"],
      consumed: ["texts"],
    });
  }
  // Their email, through Gmail's own search (`emailRead.js`).
  if (open.args?.email === true) {
    return target("search", open.args, {
      name: "search_email",
      action: "email",
      fixed: { query: call.query },
      copy: ["account", "limit"],
      consumed: ["email"],
    });
  }
  return target("search", open.args ?? {}, {
    name: "search_notes",
    action: "notes",
    fixed: { query: call.query },
    copy: ["prefix", "from", "to"],
  });
}

/** Keyword ids: exact, case-sensitive, after trimming. */
const KEYWORDS = {
  // Several notes in one call (`read_notes`): args { paths }.
  "notes:": { name: "read_notes", action: "notes", copy: ["paths"] },
  "meetings:": { name: "list_meetings", action: "meetings", copy: ["limit"] },
  "calendar:": { name: "read_calendar", action: "calendar", copy: ["date", "days", "account"] },
  "messages:": { name: "list_channel_days", action: "messages", copy: ["channel", "account", "limit"] },
  "contacts:": { name: "list_contacts", action: "contacts", copy: ["limit"] },
  "activity:": { name: "read_activity", action: "activity", copy: ["limit"] },
  "changes:": { name: "list_changes", action: "changes", copy: ["limit", "reads"] },
  "links:": { name: "list_links", action: "links", copy: [] },
  "vault:": { name: "vault_list", action: "vault", copy: [] },
  "plugins:": { name: "list_plugins", action: "plugins", copy: [] },
  "access:": { name: "scope_info", action: "access", copy: ["path", "workspaces"] },
  "apps:": { name: "app_read", action: "apps", copy: [] },
  "texts:": { name: "list_texts", action: "texts", copy: ["limit"] },
};

/** `calendar:<YYYY-MM-DD>`: the `calendar:` keyword for that day. */
const CALENDAR_DAY = /^calendar:\s*(\d{4}-\d{2}-\d{2})$/;

/** `apps:<app>`: one connected app's tools, or with `tool`, one read through it. */
const APP_PREFIX = "apps:";

/**
 * A chat's history file (`tex/history.ledger.json`, or `history.ledger.json` in a group chat's home): the chat's
 * ledger as it is now, answered by the chat's Tex object (`texStore/historyView.js`). It is a row like any Tex note
 * and `read_note` reads it with that note's access; only its name is not `.md`, so without this it fell through to a
 * folder listing and answered "no visible notes" (Dev, 2026-11-03: agents should be able to read the history files).
 */
// Its conversations file beside it is read the same way (`texStore/historyView.js`).
const HISTORY_FILE_ID = /(?:^|\/)(?:history|conversations)\.ledger\.json$/i;

/** Ids that name something other than a note, which only the table below can route. */
function routedId(id) {
  if (HISTORY_FILE_ID.test(id)) return true;
  return Object.hasOwn(KEYWORDS, id) || CALENDAR_DAY.test(id) || [APP_PREFIX, TEXTS_ID_PREFIX, EMAIL_ID_PREFIX, GOOGLE_CHAT_ID_PREFIX].some((prefix) => id.startsWith(prefix));
}

/** `fetch` in the v2 shape. */
export function translateFetch(call, app = {}) {
  const open = openArgs(call);
  if (open.error) return { error: open.error };
  if (typeof call.id !== "string") {
    return { error: "fetch needs an id: a note path, a search result id, or one of the keywords orient lists." };
  }
  // Everything but an id the table routes itself: the deep-research fetch
  // reads notes only, so an `email:` id, a keyword or a `texts:` chat its own
  // search handed out is translated as for everybody (2026-10-28: ChatGPT's
  // fetch of the `email:` id search returned was refused as an invalid id).
  if (isChatGpt(app) && open.args === undefined && !routedId(call.id.trim())) {
    return { name: "fetch", arguments: { id: call.id }, action: "note" };
  }
  const a = open.args ?? {};
  const id = call.id.trim();
  const label = `fetch "${echo(id)}"`;

  if (Object.hasOwn(KEYWORDS, id)) {
    const { name, action, copy } = KEYWORDS[id];
    return target(label, a, { name, action, copy });
  }
  // `calendar:2026-11-23` is the day it names: Tex wrote the date into the id on a preview (2026-11-22), and it was
  // read as a folder named that, "no visible notes", so it said it couldn't see their calendar.
  const day = CALENDAR_DAY.exec(id);
  if (day) {
    const { name, action, copy } = KEYWORDS["calendar:"];
    return target(label, a, { name, action, fixed: a.date === undefined ? { date: day[1] } : {}, copy });
  }
  if (id.startsWith(APP_PREFIX)) {
    const app = id.slice(APP_PREFIX.length).trim();
    return target(label, a, { name: "app_read", action: "app", fixed: { app }, copy: ["tool", "arguments"] });
  }
  if (id.startsWith(TEXTS_ID_PREFIX)) {
    return target(label, a, { name: "read_texts", action: "texts", fixed: { chat: id.slice(TEXTS_ID_PREFIX.length) }, copy: ["since", "before", "limit"] });
  }
  // Their Google Chat, live (`googleChatRead.js`): `chat:` lists their spaces, `chat:<spaces/…>`
  // reads one, and `chat:` with args `{ to }` reads the direct message with that person. Each
  // names the account it reads (`account`); bare `chat:` without one answers with their accounts.
  if (id.startsWith(GOOGLE_CHAT_ID_PREFIX)) {
    const space = id.slice(GOOGLE_CHAT_ID_PREFIX.length).trim();
    if (space !== "") return target(label, a, { name: "read_google_chat", action: "chat", fixed: { space }, copy: ["limit", "account"] });
    if (a.to !== undefined) return target(label, a, { name: "read_google_chat", action: "chat", copy: ["to", "limit", "account"] });
    return target(label, a, { name: "google_chat", action: "chat_spaces", fixed: { action: "spaces" }, copy: ["account"] });
  }
  if (id.startsWith(EMAIL_ID_PREFIX)) {
    // The email itself takes no args; its three are an attachment's (Dev2, 2026-11-23: a Lab run read `from` as the sender
    // and `summary` as "summarize", was refused twice, and ended with no answer). The offset is `start`, never `from`.
    const ATTACHMENT_ONLY = "; start (where to pick up in a long attachment, the number its more: line gave) and summary (totals over a CSV, an object) go only with attachment";
    if (a.from !== undefined) {
      return { error: `${label} takes no from: the sender is already in the id. Call it again with no args to read the email${ATTACHMENT_ONLY}.` };
    }
    if (a.attachment === undefined && (a.start !== undefined || a.summary !== undefined)) {
      return { error: `${label} reads the whole email with no args${ATTACHMENT_ONLY}. Call it again with no args to read the email.` };
    }
    return target(label, a, { name: "read_email", action: "email", fixed: { id }, copy: ["attachment", "start", "summary"], others: ATTACHMENT_ONLY });
  }

  // A chat's history file reads as the note it is, with that note's access.
  if (HISTORY_FILE_ID.test(id)) {
    return target(label, a, { name: "read_note", action: "note", fixed: { path: id }, copy: ["before", "job"] });
  }

  // A message anchor from search (`<note>.md#<anchor>`) reads that one message; `<note>.md#Plan#Risks` reads one
  // section, the way Obsidian links name one (`notes/readPart.js`). Anything else with a `#` is the path as written.
  const split = splitMessageAnchor(id);
  const fragment = headingFragment(id);
  const note = split.anchor !== null && split.path.endsWith(".md") ? split.path : fragment !== null ? fragment.path : id;
  const named = split.anchor !== null && split.path.endsWith(".md") ? split.anchor : fragment?.section ?? null;

  if (note.endsWith(".md")) {
    if (a.image !== undefined) {
      return target(label, a, { name: "read_image", action: "image", fixed: { note }, copy: ["image"] });
    }
    if (a.related === true) {
      return target(label, a, { name: "related_notes", action: "related", fixed: { path: note }, copy: ["limit"], consumed: ["related"] });
    }
    if (a.lists === true) {
      return target(label, a, { name: "evaluate_lists", action: "lists", fixed: { path: note }, consumed: ["lists"] });
    }
    if (a.transcript !== undefined) {
      return target(label, a, { name: "read_meeting", action: "meeting", fixed: { path: note }, copy: ["transcript"] });
    }
    if (a.messages !== undefined) {
      return target(label, a, { name: "read_channel_day", action: "day", fixed: { path: note }, copy: ["messages"] });
    }
    if (a.activity !== undefined) {
      return target(label, a, { name: "read_contact", action: "contact", fixed: { path: note }, copy: ["activity"] });
    }
    if (named !== null && a.section === undefined && a.lines === undefined && a.outline === undefined && a.mail === undefined) {
      return target(label, a, { name: "read_note", action: "note", fixed: { path: note, section: named }, copy: [], others: NOTE_READS });
    }
    return target(label, a, { name: "read_note", action: "note", fixed: { path: note }, copy: ["mail", "outline", "section", "lines", "full"], others: NOTE_READS });
  }

  // A sheet (a `.csv` with typed columns): its rows as a table, filtered and sorted by its args (`readSheet.js`).
  if (isSheetPath(id)) {
    return target(label, a, { name: "read_sheet", action: "sheet", fixed: { path: id }, copy: ["where", "sort", "last", "limit", "columns"] });
  }

  // A stored file (a PDF an email carried, a spreadsheet): its words.
  if (readableFileType(id) !== null) {
    return target(label, a, { name: "read_file", action: "file", fixed: { path: id }, copy: ["from", "summary"] });
  }

  // A folder: named with a trailing slash, or without one. Empty is everything.
  const prefix = id.replace(/\/+$/, "");
  return target(label, a, { name: "list_notes", action: "list", fixed: prefix === "" ? {} : { prefix } });
}
