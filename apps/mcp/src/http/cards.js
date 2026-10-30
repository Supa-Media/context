/**
 * `/cards/` — what a card in Messages shows: the person's own inbox, and when
 * their week is busy (docs/decisions/texting-assistant/visual-answers.md).
 *
 * A card's page never holds a credential. It asks the Messages extension,
 * which adds the card key the Context app left it (`CardGrant.swift`,
 * minted by `apps/convex/functions/cardsKey.ts`): a read-only grant for the
 * person's own personal workspace, on its own client. So these routes answer
 * that client and no other. An MCP client already reads mail and the calendar
 * through its tools, as words for a model; these answer as data for a page,
 * and a page is the app's own, not something a connected client should be
 * able to stand up.
 *
 *  - `GET /cards/inbox[?view=unread]` → `{ ok: true, messages: [{ address, id, date, from, subject, snippet }], incomplete, reconnect }`,
 *    the newest mail in their inbox from the last two weeks, read live from Gmail.
 *  - `GET /cards/week?from=YYYY-MM-DD&days=1..7` → `{ ok: true, days: [{ date, busy: [{ start, end }], allDay }], unanswered, reconnect }`,
 *    every connected calendar's timed events as instants only, merged: no
 *    title, place or guest, which is all a page picking free times needs.
 *  - Either answers `{ ok: false, refused }` when Google cannot be asked.
 *
 * A sender and a subject are whoever wrote the email, so a page shows them
 * as text and never as markup. Nothing here is kept.
 */

import { json } from "./responses.js";

/** The card key's client (`CARDS_CLIENT_ID` in `apps/convex/functions/cardsKey.ts`). */
export const CARDS_CLIENT_ID = "context_cards";

const INBOX_QUERIES = { inbox: "in:inbox newer_than:14d", unread: "in:inbox is:unread newer_than:14d" };
const MOST_MESSAGES = 10;
const MOST_DAYS = 7;
const MOST_BUSY = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clip(value, most) {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  return line.length > most ? `${line.slice(0, most)}…` : line;
}

const addresses = (list) => (Array.isArray(list) ? list.map((entry) => (typeof entry === "string" ? entry : entry?.address)).filter((entry) => typeof entry === "string") : []);

async function inbox(url, store) {
  const query = INBOX_QUERIES[url.searchParams.get("view") ?? "inbox"];
  if (query === undefined) return json({ ok: false, refused: "invalid" }, 400);
  let answer;
  try {
    answer = await store.email.search({ query, limit: MOST_MESSAGES, outsideSync: false });
  } catch {
    answer = null;
  }
  if (!answer?.ok) return json({ ok: false, refused: answer?.refused ?? "unavailable", reconnect: addresses(answer?.reconnect) });
  const messages = answer.results
    .filter((result) => typeof result?.address === "string" && typeof result?.id === "string")
    .slice(0, MOST_MESSAGES)
    .map((result) => ({
      address: result.address,
      id: result.id,
      date: clip(result.date, 64),
      from: clip(result.from, 120),
      subject: clip(result.subject, 200),
      snippet: clip(result.snippet, 240),
    }));
  return json({ ok: true, messages, incomplete: answer.incomplete === true, reconnect: addresses(answer.reconnect) });
}

/** The run of `days` dates from `from`, or null for one that is not a real day. */
function runOfDays(from, days) {
  if (!DATE.test(from)) return null;
  const first = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(first) || new Date(first).toISOString().slice(0, 10) !== from) return null;
  return Array.from({ length: days }, (_, i) => new Date(first + i * 86_400_000).toISOString().slice(0, 10));
}

function isBusy(block) {
  return typeof block?.start === "string" && typeof block?.end === "string" && Number.isFinite(Date.parse(block.start)) && Date.parse(block.end) > Date.parse(block.start);
}

async function week(url, store) {
  const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
  const days = Number(url.searchParams.get("days") ?? MOST_DAYS);
  const dates = Number.isInteger(days) && days >= 1 && days <= MOST_DAYS ? runOfDays(from, days) : null;
  if (dates === null) return json({ ok: false, refused: "invalid" }, 400);
  let answer;
  try {
    answer = await store.calendar.days({ date: from, days });
  } catch {
    answer = null;
  }
  if (!answer?.ok) return json({ ok: false, refused: answer?.refused ?? "unavailable", reconnect: addresses(answer?.reconnect) });
  const merged = dates.map((date) => {
    const onDay = answer.days.filter((day) => day?.date === date);
    const busy = onDay
      .flatMap((day) => (Array.isArray(day.busy) ? day.busy : []))
      .filter(isBusy)
      .map((block) => ({ start: new Date(block.start).toISOString(), end: new Date(block.end).toISOString() }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .slice(0, MOST_BUSY);
    const allDay = onDay.reduce((sum, day) => sum + (Number.isInteger(day.allDay) && day.allDay > 0 ? day.allDay : 0), 0);
    return { date, busy, allDay };
  });
  return json({ ok: true, days: merged, unanswered: addresses(answer.unanswered), reconnect: addresses(answer.reconnect) });
}

const CARD_ROUTES = new Map([
  ["/cards/inbox", inbox],
  ["/cards/week", week],
]);

export const CARD_PATHS = [...CARD_ROUTES.keys()];

/** `path` is the route as `route.js` read it, past any `@slug` or `/t/<token>`. */
export async function handleCards(request, store, session, path) {
  if (session.actorClientId !== CARDS_CLIENT_ID) {
    return json({ error: "forbidden", error_description: "Only Context's cards in Messages read this." }, 403);
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const route = CARD_ROUTES.get(path);
  if (route === undefined) return json({ error: "not_found" }, 404);
  const response = await route(new URL(request.url), store);
  // The person's own mail and week: never kept by anything between.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
