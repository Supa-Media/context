/**
 * `/tex/page` and its sub-routes: the Context app's Tex page (decided by the
 * owner, 2026-11-02; `docs/decisions/texting-assistant/tex-page.md`).
 *
 *  - `POST /tex/page`      `{handle, chat, sections?}` → the overview
 *  - `POST /tex/page/job`  `{handle, chat, id}` → `{job}`
 *  - `POST /tex/page/list` `{handle, chat, kind, cursor?}` → `{items, cursor?, ...}`
 *  - `POST /tex/page/act`  `{handle, chat, action}` → `{ok: true}` | `{ok: false, error}`
 *  - `POST /tex/page/ledger` `{handle, chat, view, ...}` → the chat's history file (`ledger.js`)
 *
 * Who may: `page.js`. Where each thing is read and written, one way each:
 * jobs from the chat's inbox in the texting Worker (`jobs.js`); what Tex
 * thought, asked the advisor and emailed from the chat's Tex object
 * (`texStore/pageRecords.js`); routines, check-ins and About through the tool
 * door every client's call goes through (`notes.js`, `callToolForSession`), so
 * a workspace kept in its object and one still in its bucket answer the same,
 * only at their own speeds; settings through the control plane. After a
 * change, the chat's open pages are told (`texStore/pageLive.js`).
 *
 * Nothing here is logged but the route, the outcome, the action's type and
 * the grant: never a note's words, a job's title or a setting.
 */

import { callToolForSession } from "../../tools/session.js";
import { actorFor, contextsFor } from "../../context/identity.js";
import { browserOwner } from "../../agent/browserProviders.js";
import { groupTagOf } from "./browser.js";
import { readPageRecords } from "../../texStore/pageRecords.js";
import { pokeTexPage } from "../../texStore/pageLive.js";
import { json } from "../responses.js";
import { fetchPageJobs, jobDetail, jobSummary, jobsOverview, slotsOf, steerPageJob } from "./jobs.js";
import * as notes from "./notes.js";
import { ledgerView } from "./ledger.js";
import { PageRefusal, chatOf, checkViewer, loadPage, pickerOf, readPageBody, startOfDay } from "./page.js";

export const TEX_PAGE_PATHS = new Set(["/tex/page", "/tex/page/job", "/tex/page/list", "/tex/page/act", "/tex/page/ledger"]);
const LIST_KINDS = new Set(["thinking", "jobs", "advisor", "mailcheck", "routines", "checkins", "about", "settings"]);
const RECORD_KINDS = new Set(["thinking", "advisor", "mailcheck"]);
const OVERVIEW_KEYS = ["chats", "chat", "status", "thinking", "thinkingToday", "minions", "earlier", "earlierWeek", "tiles", "behind"];

/** The tool door, as this person, in the chat's notes: `context` added where the notes are not the session's own workspace. */
function noteCaller(store, session, page) {
  const own = session.workspaceId === page.workspaceId ? null : `@${page.handle}`;
  return (name, args = {}) => callToolForSession({ name, arguments: own !== null && args.context === undefined ? { ...args, context: own } : args }, store, session);
}

/** A section that could not be read is shown empty, never as an error: the page's other parts still show. */
async function settled(work, empty) {
  try {
    return await work();
  } catch {
    return empty;
  }
}

/** Is Tex's browser open for this chat (the person's own, or a group's by its people), and where. Never the frame. */
async function computerOf(env, session, chat, jobs) {
  const binding = env?.SITE_SHOTS;
  const owner = chat.kind === "group" ? await groupTagOf(env, chat, (await jobs)?.people) : await browserOwner(env, session.actorUserId);
  if (typeof binding?.fetch !== "function" || owner === null) return { running: false };
  const response = await binding.fetch("https://site-shots/view/frame", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
  const body = response.ok ? await response.json().catch(() => null) : null;
  return body?.running === true ? { running: true, ...(typeof body.url === "string" ? { url: body.url.slice(0, 300) } : {}) } : { running: false };
}

/** The person's own instructions in a line (Dev2, 2026-11-01: their words are how Tex talks), or "Default". */
function instructionsSummary(text) {
  const first = String(text ?? "").split("\n")[0].trim();
  return first === "" ? "Default" : first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

const ANSWERS = { quiet: "named", attentive: "named", followAlong: "named", helpful: "every" };
const answersOf = (engagement) => ANSWERS[engagement] ?? "named";

function settingsSummary(chat) {
  if (chat.kind === "me") return instructionsSummary(chat.instructions);
  return answersOf(chat.engagement) === "every" ? "Answers every message" : "Answers when named";
}

function nextOf(rows) {
  const times = rows.map((row) => row.nextRunAt).filter((at) => typeof at === "number");
  return times.length > 0 ? Math.min(...times) : null;
}

/** The overview, all of it or the `sections` asked for. */
async function overview(env, session, page, chat, call, sections) {
  const want = new Set(Array.isArray(sections) && sections.length > 0 ? sections : OVERVIEW_KEYS);
  const now = Date.now();
  const since = startOfDay(now, page.timeZone);
  const needJobs = ["status", "minions", "earlier", "earlierWeek"].some((key) => want.has(key));
  const needTiles = want.has("tiles");
  // A group's computer tile needs its people hash, which comes with its jobs.
  const jobsRead = needJobs || (needTiles && chat.kind === "group") ? fetchPageJobs(env, chat.jobsChat, now) : null;
  const [thinking, advisor, mailcheck, jobs, routines, about, computer] = await Promise.all([
    want.has("thinking") || want.has("thinkingToday") ? readPageRecords(env, chat.owner, "thinking", { limit: 3, since }) : null,
    want.has("behind") ? readPageRecords(env, chat.owner, "advisor", { limit: 1, since }) : null,
    want.has("behind") || needJobs ? readPageRecords(env, chat.owner, "mailcheck", { limit: 1, since }) : null,
    needJobs ? jobsRead : null,
    needTiles ? settled(() => notes.readRoutines(call, chat.routines, { now, timeZone: page.timeZone }), { routines: [], checkins: [] }) : null,
    needTiles && chat.about ? settled(() => notes.readAbout(call, chat.about), { items: [], total: 0 }) : null,
    needTiles ? settled(() => computerOf(env, session, chat, jobsRead), { running: false }) : null,
  ]);
  const answer = {};
  if (want.has("chats")) answer.chats = pickerOf(page);
  if (want.has("chat")) answer.chat = { key: chat.key, name: chat.name, ...(chat.kind === "group" ? { people: chat.people } : {}) };
  if (thinking) {
    if (want.has("thinking")) answer.thinking = thinking.items;
    if (want.has("thinkingToday")) answer.thinkingToday = thinking.count ?? thinking.items.length;
  }
  if (jobs) {
    const parts = jobsOverview(jobs.jobs, jobs.now, { timeZone: page.timeZone, waitingMail: mailcheck?.waiting ?? 0 });
    for (const key of ["status", "minions", "earlier", "earlierWeek"]) if (want.has(key)) answer[key] = parts[key];
  }
  if (needTiles) {
    const routineRows = chat.routines.filter((row) => row.unit !== "once");
    const checkinRows = chat.routines.filter((row) => row.unit === "once" && typeof row.nextRunAt === "number");
    const routineNext = nextOf(routineRows.filter((row) => !row.paused));
    const checkinNext = nextOf(checkinRows);
    const aboutItems = about?.items ?? [];
    answer.tiles = {
      routines: { on: routineRows.filter((row) => !row.paused).length, ...(routineNext !== null ? { next: routineNext } : {}) },
      checkins: { ...(checkinNext !== null ? { next: checkinNext } : {}), count: routines?.checkins?.length ?? 0 },
      about: { count: about?.total ?? aboutItems.length, newToday: aboutItems.filter((item) => item.isNew).length },
      computer: computer ?? { running: false },
      settings: { summary: settingsSummary(chat) },
    };
  }
  if (want.has("behind")) {
    answer.behind = {
      advisor: { today: advisor?.count ?? 0, ...(advisor?.items?.[0]?.question ? { last: advisor.items[0].question } : {}) },
      mailcheck: { today: mailcheck?.count ?? 0, waiting: mailcheck?.waiting ?? 0 },
    };
  }
  return answer;
}

async function list(env, page, chat, call, kind, cursor) {
  const now = Date.now();
  if (RECORD_KINDS.has(kind)) {
    const found = await readPageRecords(env, chat.owner, kind, { limit: 20, cursor, since: startOfDay(now, page.timeZone) });
    return { items: found.items, ...(found.cursor ? { cursor: found.cursor } : {}), today: found.count ?? 0 };
  }
  if (kind === "jobs") {
    const { jobs } = await fetchPageJobs(env, chat.jobsChat, now);
    const slots = slotsOf(jobs);
    return { items: [...jobs].sort((a, b) => b.startedAt - a.startedAt).map((job) => jobSummary(job, slots.get(job.id) ?? null)) };
  }
  if (kind === "routines" || kind === "checkins") {
    const read = await settled(() => notes.readRoutines(call, chat.routines, { now, timeZone: page.timeZone }), { routines: [], checkins: [] });
    if (kind === "routines") return { items: read.routines };
    const extras = chat.kind === "me" ? await settled(() => notes.readCheckinSettings(call), {}) : {};
    return { items: read.checkins, ...(extras.looksAt ? { looksAt: extras.looksAt } : {}), ...(extras.quietHours ? { quietHours: extras.quietHours } : {}) };
  }
  if (kind === "about") {
    if (!chat.about) return { items: [], total: 0 };
    const read = await settled(() => notes.readAbout(call, chat.about), { items: [], total: 0 });
    return { items: read.items, total: read.total };
  }
  // Settings: the person's own instructions, or the chat's, with the quick picks that add a line to them.
  if (chat.kind === "me") return { items: [], instructions: chat.instructions, picks: chat.picks };
  return {
    items: [],
    instructions: chat.instructions,
    picks: chat.picks,
    values: { answers: answersOf(chat.engagement) },
    ...(chat.sponsor ? { approver: chat.sponsor } : {}),
    people: chat.peopleNames,
  };
}

/** What a page act changes on the chat's page, so open pages read it again. */
const ACT_SECTIONS = {
  steer: ["jobs"],
  stop: ["jobs"],
  report: [],
  "routine.toggle": ["routines"],
  "routine.remove": ["routines"],
  "checkin.edit": ["checkins"],
  "checkin.cancel": ["checkins"],
  "checkin.add": ["checkins"],
  "about.fix": ["about"],
  "about.remove": ["about"],
  settings: ["settings"],
  "group.settings": ["settings"],
};

const text = (value, max) => (typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null);

async function act(env, controlPlane, session, page, chat, call, action) {
  const type = typeof action?.type === "string" ? action.type : null;
  if (type === null || !(type in ACT_SECTIONS)) return { ok: false, error: "unknown_action" };
  switch (type) {
    case "steer":
    case "stop": {
      const id = text(action.job, 80);
      const said = type === "steer" ? text(action.text, 1000) : null;
      if (id === null || (type === "steer" && said === null)) return { ok: false, error: "invalid" };
      const taken = await steerPageJob(env, chat.jobsChat, { id, ...(said ? { text: said } : {}), stop: type === "stop" });
      return taken ? { ok: true } : { ok: false, error: "not_found" };
    }
    case "report": {
      const id = text(action.job, 80);
      if (id === null) return { ok: false, error: "invalid" };
      // Only a job this chat keeps, and its own words: the page never sends what the person typed elsewhere.
      const { jobs } = await fetchPageJobs(env, chat.jobsChat);
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job) return { ok: false, error: "not_found" };
      const step = Number.isSafeInteger(action.step) ? job.steps[action.step] : job.steps.find((candidate) => candidate.failed);
      const lines = [`Tex page: a step in "${job.title}" did not work.`, ...(step ? [`Step: ${step.text}`, ...(step.why ? [`Why: ${step.why}`] : [])] : []), `Job state: ${job.state}.`];
      const filed = await controlPlane.reportProblem(session.accessToken, lines.join("\n")).catch(() => null);
      return filed?.eventId ? { ok: true } : { ok: false, error: filed?.refused ?? "unavailable" };
    }
    case "routine.toggle":
      return await notes.routineToggle(call, action.id, action.on === true);
    case "routine.remove":
      return await notes.routineRemove(call, action.id);
    case "checkin.edit":
      return await notes.checkinEdit(call, action.id, { when: action.when, what: action.what });
    case "checkin.cancel":
      return await notes.checkinCancel(call, action.id);
    case "checkin.add":
      if (chat.kind !== "me") return { ok: false, error: "text_tex" };
      return await notes.checkinAdd(call, { when: action.when, what: action.what });
    case "about.fix":
      if (!chat.about) return { ok: false, error: "not_found" };
      return await notes.aboutFix(call, chat.about, action.line, action.text);
    case "about.remove":
      if (!chat.about) return { ok: false, error: "not_found" };
      return await notes.aboutRemove(call, chat.about, action.line);
    default: {
      // `settings` (the person's own) and `group.settings` (the chat's): the control plane checks the chat again.
      if ((type === "settings") !== (chat.kind === "me")) return { ok: false, error: "invalid" };
      const answer = await controlPlane.texPageSettings(session.accessToken, chat.key, action.values ?? {}).catch(() => null);
      return answer?.status === "done" ? { ok: true } : { ok: false, error: answer?.status ?? "unavailable" };
    }
  }
}

/** A routine or check-in id names a note in the person's workspace or a group's; one in a group's is only that group's. */
export function actOwned(chat, action) {
  if (typeof action?.id !== "string" || !action.type?.startsWith?.("routine") && !action.type?.startsWith?.("checkin")) return true;
  if (action.type === "checkin.add") return true;
  return chat.routines.some((row) => `${row.slug ?? ""}:${row.path}` === action.id);
}

export async function handleTexPage(request, env, store, session, { path, controlPlane }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const started = Date.now();
  let outcome = "ok";
  let actionType = null;
  try {
    const body = await readPageBody(request);
    if (body === null) {
      outcome = "invalid";
      return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
    }
    checkViewer(session, body.handle);
    const page = await loadPage(controlPlane, session);
    const chat = chatOf(page, body.chat);
    // Writes through the tool door name who made them, as every client's do.
    store.actor = actorFor(session);
    store.contexts = contextsFor(session);
    const call = noteCaller(store, session, page);
    if (path === "/tex/page") return json(await overview(env, session, page, chat, call, body.sections));
    if (path === "/tex/page/job") {
      const { jobs } = await fetchPageJobs(env, chat.jobsChat);
      const job = typeof body.id === "string" ? jobs.find((candidate) => candidate.id === body.id) : undefined;
      if (!job) {
        outcome = "not_found";
        return json({ error: "not_found" }, 404);
      }
      return json({ job: jobDetail(job, slotsOf(jobs).get(job.id) ?? null) });
    }
    if (path === "/tex/page/ledger") return json(await ledgerView(env, page, chat, body)); // the chat's history file (`ledger.js`)
    if (path === "/tex/page/list") {
      if (!LIST_KINDS.has(body.kind)) {
        outcome = "invalid";
        return json({ error: "invalid_request", error_description: "Unknown list." }, 400);
      }
      return json(await list(env, page, chat, call, body.kind, typeof body.cursor === "string" ? body.cursor : null));
    }
    actionType = typeof body.action?.type === "string" ? body.action.type.slice(0, 40) : null;
    if (!actOwned(chat, body.action)) {
      outcome = "not_found";
      return json({ ok: false, error: "not_found" });
    }
    const answer = await act(env, controlPlane, session, page, chat, call, body.action);
    outcome = answer.ok ? "done" : `refused_${answer.error}`;
    if (answer.ok) {
      const sections = ACT_SECTIONS[actionType] ?? [];
      if (sections.length > 0) await pokeTexPage(env, chat.owner, sections);
    }
    return json(answer);
  } catch (error) {
    if (!(error instanceof PageRefusal)) throw error;
    outcome = error.error;
    return error.response();
  } finally {
    console.log(
      JSON.stringify({
        event: "tex_page",
        route: path,
        ...(actionType ? { action: actionType } : {}),
        outcome,
        workspace_id: session.workspaceId ?? null,
        grant_id: session.grantId ?? null,
        ms: Date.now() - started,
      }),
    );
  }
}
