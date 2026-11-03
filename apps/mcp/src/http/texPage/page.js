/**
 * Who may see a Tex page, and which chat it is (decided by the owner,
 * 2026-11-02: the page at `context.lc/tex/@handle`, signed-in only, a chat
 * picker of "Just you" and each group the person is in).
 *
 * The rules are `/tex/computer`'s (`http/texComputer.js`), and more:
 *
 *  - **The Context app's own client only** (`context_console`). An AI client
 *    holding the person's grant must not read what Tex thought, what it
 *    emailed, or steer its jobs.
 *  - **The handle must be the caller's own**, the slug of the personal
 *    workspace they own.
 *  - **A group must be one the person is in now.** The control plane answers
 *    the person's chats off their live grant (`/gateway/tex/page`), never off
 *    anything in the request, and a key the person is not in is answered
 *    exactly as a key that names nothing: `404 not_found`.
 *
 * What a chat is: `owner`, its Tex object (`person:<workspaceId>` or
 * `chat:<groupKey>`, where its records live and its page's socket is held);
 * `jobsChat`, how the texting Worker finds its inbox (`{phone}` or
 * `{groupKey}`); and where its notes are.
 */

import { ownHandle } from "../texComputer.js";
import { json } from "../responses.js";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
export const CONSOLE_CLIENT_ID = "context_console";
const GROUP_KEY = /^[0-9a-f]{64}$/;
/** The most one page request carries: an About line's fix is the largest thing typed. */
export const MAX_PAGE_BODY_BYTES = 16_384;

export class PageRefusal extends Error {
  constructor(status, error, description) {
    super(description);
    this.status = status;
    this.error = error;
  }

  response() {
    return json({ error: this.error, error_description: this.message }, this.status);
  }
}

/** The handle a request names, without its `@`, lower-cased. */
export function handleOf(value) {
  return typeof value === "string" ? value.replace(/^@/, "").toLowerCase() : "";
}

/** Refuses anyone but the console's client opening their own page. */
export function checkViewer(session, handle) {
  if (session?.actorClientId !== CONSOLE_CLIENT_ID) throw new PageRefusal(403, "forbidden", "Only the Context app can show this page.");
  const mine = ownHandle(session);
  if (mine === null || handleOf(handle) !== mine) throw new PageRefusal(403, "not_yours", "This page belongs to someone else.");
}

/**
 * The person's page as the control plane answers it (`controlPlane.texPage`):
 * their personal workspace, phone, time zone, instructions, routine rows and chats.
 */
export async function loadPage(controlPlane, session) {
  let answer = null;
  try {
    answer = await controlPlane.texPage(session.accessToken);
  } catch {
    answer = null;
  }
  if (answer?.status !== "ok" || typeof answer.workspaceId !== "string") throw new PageRefusal(503, "unavailable", "The page could not be read just now.");
  return answer;
}

/**
 * The chats the picker offers: "Just you", then each group, with its home's
 * workspace and folder when it has one, so the app can open a home's history
 * file as this chat's history (`tex/groups/<words>/history.ledger.json`).
 */
export function pickerOf(page) {
  return [
    { key: "me", name: "Just you" },
    ...(page.chats ?? []).map((chat) => ({
      key: chat.key,
      name: chat.name,
      people: chat.people,
      ...(homeOf(chat) ? { home: homeOf(chat) } : {}),
    })),
  ];
}

/** A group's home as `{context: "@slug", folder: "tex/groups/<words>"}`, or null when it has none. */
function homeOf(group) {
  const ok = typeof group.homeWords === "string" && group.homeWords && typeof group.homeSlug === "string" && group.homeSlug;
  return ok ? { context: `@${group.homeSlug}`, folder: `tex/groups/${group.homeWords}` } : null;
}

/**
 * The chat the request names, or a `404 not_found` that says the same for a
 * group the person is not in and one that does not exist.
 */
export function chatOf(page, key) {
  if (key === "me" || key === undefined || key === null || key === "") {
    return {
      kind: "me",
      key: "me",
      name: "Just you",
      owner: { person: page.workspaceId },
      jobsChat: typeof page.phone === "string" && page.phone ? { phone: page.phone } : null,
      routines: page.routines ?? [],
      instructions: typeof page.instructions === "string" ? page.instructions : "",
      picks: Array.isArray(page.picks) ? page.picks : [],
      about: { path: "tex/about.md" },
    };
  }
  const group = typeof key === "string" && GROUP_KEY.test(key) ? (page.chats ?? []).find((chat) => chat.key === key) : undefined;
  if (!group) throw new PageRefusal(404, "not_found", "There is no such chat.");
  const home = homeOf(group);
  return {
    kind: "group",
    key: group.key,
    name: group.name,
    people: group.people,
    peopleNames: group.peopleNames ?? [],
    owner: { chat: group.key },
    jobsChat: { groupKey: group.key },
    routines: group.routines ?? [],
    instructions: typeof group.instructions === "string" ? group.instructions : "",
    picks: Array.isArray(page.picks) ? page.picks : [],
    engagement: group.engagement ?? null,
    sponsor: group.sponsor ?? null,
    about: home ? { context: home.context, path: `${home.folder}/about.md` } : null,
  };
}

/** The request's JSON object, or null: a body too large, not JSON, or not an object. */
export async function readPageBody(request) {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_PAGE_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Midnight today where the person is, as epoch ms (UTC when the zone is not one). */
export function startOfDay(now, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    const hours = Number(parts.hour) % 24;
    return now - ((hours * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 - (now % 1000);
  } catch {
    return now - (now % 86_400_000);
  }
}
