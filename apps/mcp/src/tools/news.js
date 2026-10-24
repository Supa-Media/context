/**
 * What changed in this gateway's tools, told through `orient` to the clients
 * still describing them as they were.
 *
 * ## Why this exists
 *
 * A client caches `tools/list` and re-fetches on its own schedule — some at
 * every new chat, some only when a person reconnects (PR #782 found this;
 * `advertised.js` keeps the old names working for the same reason). MCP's
 * own answer, `notifications/tools/list_changed`, needs a stream this
 * stateless gateway does not hold, and nothing a server or a model says can
 * make a client reload. So a connection can go on reading the descriptions of
 * the day it connected, and never learn that `write_note` takes `comment`.
 *
 * What does reach every client is `orient`, which every session calls first.
 * The control plane records when each grant last fetched `tools/list`
 * (`oauthGrants.toolsListedAt`), and `orient` names the entries below that
 * are newer. Arguments are checked against *today's* schema on every call
 * (`tools/session.js`), whatever the client cached, so an agent that reads an
 * entry here can pass the new argument at once. A new *tool* is different: a
 * client calls only tools it has loaded, so for those the line says to
 * reconnect.
 *
 * ## Keeping it honest
 *
 * `toolNews.test.mjs` fingerprints every advertised tool's name and argument
 * names. Changing either fails that test until this list gains an entry and
 * `TOOL_SHAPE` is updated to the value the test prints. Descriptions are not
 * fingerprinted: rewording one is not news.
 */

import { unlistedArgumentAdvice } from "./liveList.js";

/**
 * Newest first. `date` is the UTC day it shipped; `text` is written for the
 * model reading orient, naming the tool and the exact argument. `newTool`
 * marks a whole new tool, which a stale client cannot call until it reloads.
 *
 * @type {ReadonlyArray<{date: string, text: string, newTool?: true}>}
 */
export const TOOL_NEWS = Object.freeze([
  {
    date: "2026-10-24",
    text:
      "read_file and read_email (with `attachment`) take `from`: the character a long file's next part starts at, which each part names under `more:`. " +
      "For a CSV or TSV they also take `summary` (`by` columns or \"month\", `where` [{ column, contains }], `dates` { from, to }): totals over every row, exact repeats left out.",
  },
  {
    date: "2026-10-24",
    text:
      "send_email and calendar_event take `as` in a group chat: the handle of the person in the chat it goes from, when that isn't whoever tagged Tex. " +
      "They are shown the exact copy, and only their 👍 or yes makes it.",
  },
  {
    date: "2026-10-23",
    text:
      "calendar_event takes `calendar`: the address of one of their connected Google accounts (fetch calendar: names each). " +
      "A create goes on that calendar; any other change looks for the event there only.",
  },
  {
    date: "2026-10-23",
    text:
      "calendar_event takes action `edit` (find the event by `title` and `start` as they are now, then any of `new_title`, `new_start` + `new_end`, " +
      "`location`, `notes`, `add_guests`, `remove_guests`, `meet`, `reminders`, `recurrence`) and `rsvp` (`response`: accepted, declined or tentative); " +
      "`all_events: true` changes every time a repeating event happens. create also takes `reminders` (minutes before) and `recurrence` (RRULE lines).",
  },
  {
    date: "2026-10-23",
    text:
      "calendar_event create takes `guests` (email addresses to invite) and `meet: true` (a Google Meet link, given back when made). " +
      "An invite is shown to the person with the guests named, and their yes or 👍 makes it and Google emails the invite.",
  },
  {
    date: "2026-10-22",
    newTool: true,
    text:
      "send `google_chat` (google_chat `{ to | space, text }`, or `{ action: \"spaces\" }` to list their spaces) sends one Google Chat " +
      "message as the person: a direct message to a person by their work email, or a post in a space by its name. It waits for their 👍 " +
      "to the exact message. Until their Google account allows it, it says so and how they reconnect.",
  },
  {
    date: "2026-10-22",
    text:
      "calendar_event moves and cancels events with guests too: the person is shown the change with the guests named, and their yes " +
      "or 👍 makes it and Google tells the guests. `notify_guests` is set by Context on that approved change; leave it out.",
  },
  {
    date: "2026-10-22",
    text:
      "materialize_move is gone. A folder move no longer leaves a pass to finish: move_folder moves the folder in one step, or says it could not, so there is nothing to resume.",
  },
  {
    date: "2026-10-22",
    text:
      'send_email and save_email_draft take `attach`: up to 5 "download:<id>" ids a browse `download` step gave. Each goes in as a real ' +
      "attachment, so a PDF found on a site (an invoice, a statement) reaches the recipient without the person downloading it.",
  },
  {
    date: "2026-10-21",
    text:
      'fetch id "calendar:" with args `{ date: "YYYY-MM-DD", days? }` reads what is on the person\'s calendar that day (and up to 13 days after), ' +
      "asked of every connected Google calendar at that moment. Use it for any question about a date.",
  },
  {
    date: "2026-10-21",
    newTool: true,
    text:
      "send `forward_rule` `{ action: start | stop, routine, to?, about? }` lets one routine under tex/routines/ keep forwarding one kind " +
      "of the person's mail (receipts, invoices) to one address without asking each time, once they 👍 the rule. Write the routine first. " +
      "Its run forwards each match with send email `forward`, only to that address, each email once. stop ends it at once.",
  },
  {
    date: "2026-10-21",
    text:
      "send email and email_draft take `forward`: the email:<address>/<id> id of an email to pass on. It goes below the body with all of its attachments, " +
      "from that mailbox, so a receipt reaches a bookkeeper with its PDF.",
  },
  {
    date: "2026-10-21",
    newTool: true,
    text:
      "fetch `apps:` lists every app Context connects (Linear, Notion, Jira and Confluence, Planning Center, Airtable, monday.com, " +
      "Calendly, ClickUp, Todoist, Slack) and whether the person connected it; anything not listed needs the browser. " +
      "manage connect `{ app }` gives the link for any of them. fetch `apps:<app>` lists its tools, and with args `{ tool, arguments }` runs a read; " +
      "send app `{ app, tool, arguments }` makes a change once they say yes.",
  },
  {
    date: "2026-10-21",
    newTool: true,
    text:
      'manage has a new action, connect `{ app: "slack" }`: a link where the person connects Slack through its own approval screen. ' +
      'send slack `{ method, args, team? }` then calls the Slack Web API through it; a post waits for their yes to its words.',
  },
  {
    date: "2026-10-20",
    text:
      'manage has a new action, invite `{ people: [{ who, role? }] }` with context set to a shared workspace the person owns: ' +
      "Context emails each person (an email address or a @handle) an invitation, as an editor unless role is member. " +
      "create_workspace takes the same list as `invite`, so one yes makes the workspace and asks them in. Both wait for the person's yes.",
  },
  {
    date: "2026-10-20",
    text:
      "send_email and save_email_draft take `in_reply_to`: the email:<address>/<id> id search_email gave for the email being answered. " +
      "The reply goes inside that email's thread, from that mailbox.",
  },
  {
    date: "2026-10-20",
    text:
      "search with `args: { email: true }` now asks the person's Gmail itself, over all of their mail, sent and received; it no longer " +
      "lists synced mail notes, whose search could not find a message inside a long day. Every result is an `email:<address>/<id>` id to fetch.",
  },
  {
    date: "2026-10-19",
    text:
      "fetch with a file's path (a PDF, Word, Excel, CSV or picture file a note links, such as an email attachment under " +
      "`inbox/email/<mailbox>/attachments/`) returns the words in the file, marked untrusted. Older clients can call read_file `{ path }`. " +
      "fetch an `email:<address>/<id>` id with `args: { attachment: 1 }` reads that email's first attachment straight from Gmail.",
  },
  {
    date: "2026-10-19",
    newTool: true,
    text:
      "send `email_draft` (save_email_draft `{ to, cc?, subject, body, from? }`) saves one email as a draft in the person's own Gmail " +
      "for them to send themselves. Nothing is sent, so it runs at once with no yes. Use it when they ask for a draft; until their Gmail " +
      "allows drafts it says so, and you give them the draft to copy.",
  },
  {
    date: "2026-10-18",
    text:
      "search with `args: { email: true }` searches the person's email: their synced mail notes first, then their Gmail itself for " +
      "mail from before the mailbox was connected or since its last sync. A Gmail result's id is `email:<address>/<id>`; fetch it " +
      "to read that email. Their own personal workspace, with private access, only.",
  },
  {
    date: "2026-10-18",
    text:
      "manage action folder_job `{ job, path? , remove? }` chooses which folder does a built-in job, wherever it is nested: " +
      "`path` gives the job to that folder (owner only; nothing moves), `remove: true` takes an optional one (clients, teams, " +
      "products) away, and `job` alone makes its folder at the top. Jobs: inbox, projects, areas, resources, archive, tex, " +
      "clients, teams, products. Use it after an import whose folders orient lists as not found.",
  },
  {
    date: "2026-10-18",
    text:
      "Every tool takes `person_said`: before anything that lets more people see something (a link, publishing, naming people, " +
      "a visibility change), pass the person's own words asking for it, exactly as they wrote them, with your question first " +
      "if they were answering it. Without words that ask for it, the call is not done and says so; nobody approves anything in an app.",
  },
  {
    date: "2026-10-17",
    text:
      "write action report_problem takes `share_texts: true` by text with Tex only: the person is shown the exact report and must reply YES, " +
      "and only then do your last few texts with them go to the Context team with it. Every report by text waits for that YES.",
  },
  {
    date: "2026-10-17",
    text:
      "send action notify `{ message, urgency: \"emergency\" | \"asked\" | \"fyi\", why? }` has Tex text the person now: when they asked " +
      "to be told (\"text me when it ships\") or something is broken and cannot wait. Their own settings (tex/attention.md, strict by default) " +
      "may hold it, ordinary pings never go at night, and there is a daily limit, so send it once. Their own personal workspace only.",
  },
  {
    date: "2026-10-17",
    newTool: true,
    text:
      "send `calendar` (calendar_event `{ action: create | move | cancel, title, start, end?, new_start?, new_end?, location?, notes? }`) " +
      "adds, moves or cancels one event on the person's own Google Calendar. It never changes at once: the person is shown that exact change " +
      "and must say yes. Times carry their offset or are whole days; move and cancel name the event by its exact title and current start. " +
      "Until their calendar allows changes it says so, and you tell them what to change instead.",
  },
  {
    date: "2026-10-17",
    text:
      "manage action dream_now (no args) starts Tex's dream for the person now instead of at 3 am: it rewrites tex/about-me.md " +
      "within a few minutes and texts nobody. For onboarding, after you have read their recent email; read the note in a later turn " +
      "and confirm it with them. Owner of their own personal workspace only, where their plan includes dreams, never while one runs, at most once every six hours; " +
      "the answer says which, in words you can pass on.",
  },
  {
    date: "2026-10-17",
    newTool: true,
    text:
      "send `email` (send_email `{ to, cc?, subject, body, from? }`) sends one email as the person through their own Gmail. " +
      "It never sends at once: the person is shown that exact email and must say yes, and a changed email is asked about again. " +
      "Until their Gmail allows sending it says so, and you give them the draft instead.",
  },
  {
    date: "2026-10-17",
    text:
      'manage has three new actions, callable now: create_workspace `{ slug, name }` makes a shared workspace the person owns ' +
      '(`dry_run: true` checks the @handle is free), layout `{ template: "para" | "business" | "product" }` or `{ folder }` ' +
      "lays a workspace out (pass context), and connect_google `{ kind: \"gmail\" | \"calendar\" }` gives the link where the " +
      "person connects Google themselves.",
  },
  {
    date: "2026-10-17",
    text:
      'manage action visibility takes `people: [{ who, role }]`: who else may open one note, named by a member\'s or a group\'s @handle ' +
      "or by anyone's email address, with role view or edit. It adds to the people already named, and runs at once.",
  },
  {
    date: "2026-10-16",
    newTool: true,
    text:
      "Context's tools are now six: orient, search, fetch, write, manage and send. Every older name still works, " +
      'so an old call is answered as before. Reconnect to load the six. orient about: "tools" lists every action ' +
      "and the arguments it takes, as they are today. Write, manage and send take `action` and `args`.",
  },
  {
    date: "2026-10-16",
    text:
      "vault_list `fetch: { entry, field, env, url, method, headers: [{ name, value }], body }` calls an API with a saved key you never see: " +
      "Context adds the key, only on the one site vault_list names for that entry, and hides it in the answer. " +
      "Where it is not switched on yet, it says so.",
  },
  {
    date: "2026-10-15",
    text:
      'Mail between agents working on one note: write_note `mail: { join: "builder" }` gives you a mailbox id; ' +
      "pass `mailbox` on every call and answers say when mail is new for you; send with write_note `mail: { text, to }`, " +
      "read with read_note `mail: true`.",
  },
  {
    date: "2026-10-15",
    text:
      "orient `tools: true` lists every tool you may call and its arguments as they are today. " +
      "orient shows that list by itself whenever your app's copy is out of date.",
  },
  {
    date: "2026-10-15",
    text:
      "write_note `upload: [{ name, sha256, bytes }]` hands back a curl command per picture file (sent once, within 10 minutes); " +
      "then `images: [{ name, sha256 }]` embeds it, so a screenshot on disk never goes through base64.",
  },
  {
    date: "2026-10-12",
    text: 'write_note `site: { action: "domain" }` shows or connects a website\'s own domain and the DNS records it needs.',
  },
  {
    date: "2026-10-07",
    text: "remember works without `note`: a fact with no note it belongs in is filed under inbox/memories.",
  },
  {
    date: "2026-10-03",
    text:
      'write_note `site` builds websites: `{ action: "check" }`, `{ action: "publish", draft }`, ' +
      '`{ action: "screenshot", page }` and `{ action: "history" }` to roll back.',
  },
  {
    date: "2026-10-02",
    newTool: true,
    text: "remember saves one durable fact about the person into the note it belongs in.",
  },
  {
    date: "2026-09-30",
    newTool: true,
    text: "report_problem reports a problem with Context itself to the people who build it.",
  },
  {
    date: "2026-09-29",
    text: 'write_note `comment: { action: "delete", thread }` takes back your own latest comment.',
  },
  {
    date: "2026-09-28",
    newTool: true,
    text: "suggest_destination asks which of the workspaces you reach a piece of content belongs in.",
  },
  {
    date: "2026-09-27",
    text:
      "write_note `comment: { action: add|reply|resolve|reopen, quote, thread, text }` comments on a note " +
      "without rewriting it; read_note lists open threads.",
  },
  {
    date: "2026-09-26",
    text: "write_note `images` attaches pictures to a note in the same write.",
  },
]);

/**
 * The fingerprint of every advertised tool's name and argument names at the
 * time of the newest entry above. See `toolNews.test.mjs`.
 */
export const TOOL_SHAPE = "ac0df738";

/** How many entries orient shows before summing up the rest. */
const NEWS_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The fingerprint `TOOL_SHAPE` is compared with: FNV-1a over each tool's name
 * and sorted argument names, tools sorted by name. Not a security measure,
 * only a tripwire for "the tools changed and nobody wrote it down".
 *
 * @param {Array<{name: string, inputSchema?: {properties?: object}}>} tools
 */
export function toolShape(tools) {
  const text = tools
    .map((tool) => `${tool.name}(${Object.keys(tool.inputSchema?.properties || {}).sort().join(",")})`)
    .sort()
    .join(" ");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The orient section for a connection that last loaded our tools at
 * `listedAt` (epoch ms), or `null` when there is nothing newer or the time is
 * unknown. An entry dated the same UTC day as the listing is included, since
 * a day's date cannot say which came first; repeating one line is cheaper
 * than hiding one.
 *
 * @param {number | null | undefined} listedAt
 * @param {ReadonlyArray<{date: string, text: string, newTool?: true}>} [news]
 * @param {{dropsUnknown?: boolean, client?: string | null}} [app] see `appOf` in `liveList.js`
 */
export function toolNewsSection(listedAt, news = TOOL_NEWS, app = {}) {
  if (!Number.isFinite(listedAt)) return null;
  const listedDay = Math.floor(listedAt / DAY_MS) * DAY_MS;
  const fresh = news.filter((entry) => Date.parse(`${entry.date}T00:00:00Z`) >= listedDay);
  if (fresh.length === 0) return null;
  const shown = fresh.slice(0, NEWS_LIMIT);
  const lines = shown.map((entry) =>
    entry.newTool
      ? `- ${entry.date} — new tool: ${entry.text} Your app loads a new tool only when Context is reconnected or a new chat starts.`
      : `- ${entry.date} — ${entry.text}`
  );
  if (fresh.length > shown.length) lines.push(`- …and ${fresh.length - shown.length} older changes.`);
  const since = new Date(listedAt).toISOString().slice(0, 10);
  return (
    `## New in Context's tools since your app loaded them (${since})\n\n` +
    `Your copy of these tools' descriptions may be older than this list. ${unlistedArgumentAdvice(app)}\n\n` +
    lines.join("\n")
  );
}
