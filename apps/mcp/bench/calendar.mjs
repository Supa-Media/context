/**
 * The person's Google Calendar, as the bench world's control plane answers
 * for it (`world.mjs`), from the calendar days their workspace's fixture holds.
 */

/** The live calendar route's answer, from the calendar days a workspace's fixture holds. */
export function calendarAnswer(days) {
  if (days.length === 0) return null;
  return ({ date, days: count = 1 }) => {
    const start = Date.parse(`${date}T00:00:00Z`);
    const wanted = Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    return { ok: true, days: days.filter((day) => wanted.includes(day.date)).map(({ date: on, address, text }) => ({ address, date: on, text })) };
  };
}

/**
 * A calendar whose fixture days name guests (`**Attendees:**`) may be changed,
 * and a move or cancel there tells those guests, so it waits for the person's
 * 👍 (tests/corrections.md). One without stays as before: no calendar to change.
 */
export function calendarWrites(days) {
  const guests = [...new Set(days.flatMap((day) => [...day.text.matchAll(/^\*\*Attendees:\*\* (.+)$/gm)].flatMap((m) => m[1].match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [])))];
  const own = new Set(days.map((day) => day.address));
  const others = guests.filter((guest) => !own.has(guest));
  return others.length === 0 ? {} : { calendarAddress: days[0].address, calendarGuests: others };
}

/**
 * The calendar flags a world starts with: its fixture's days and who may be changed, and, for a test that says its
 * person has a calendar connected (`calendar: connected`, a Dev conversation whose setting gives Tex their calendar),
 * an empty one that reads and takes their own changes when the fixture holds no days.
 */
export function benchCalendar(days, connectedFor = null) {
  const flags = { calendarDays: calendarAnswer(days), ...calendarWrites(days), calendarGuestsFor: eventGuests(days) };
  if (connectedFor === null) return flags;
  // Connected with a fixture's days: their own calendar takes their changes too. Without this a fixture whose days
  // name no guests could be read but not changed, and every add was refused as no calendar connected.
  if (days.length > 0) return { calendarAddress: days[0].address, ...flags };
  const address = `${String(connectedFor).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@calendar.bench.invalid`;
  return { ...flags, calendarDays: () => ({ ok: true, days: [] }), calendarAddress: address };
}

/**
 * The guests of the one fixture event a change names, by its title and the day its `start` falls on (2026-11-26,
 * `tests/fd-completion.md`): with every event's guests, moving Friday's haircut, which has none, would be refused as
 * "has guests" because Austin and Sarah are on October 20, and put to Maya for a 👍 Google would never need. The
 * person's own address is not a guest. Null when no fixture event has that title, so the stub falls back to every event's guests.
 */
export function eventGuests(days) {
  const events = days.flatMap((day) =>
    day.text.split(/^(?=### )/m).filter((part) => part.startsWith("### ")).map((part) => {
      const title = /^### [^·\n]*·\s*(.+?)(?:\s*\{#[^}]*\})?\s*$/m.exec(part)?.[1] ?? "";
      const listed = /^\*\*Attendees:\*\* (.+)$/m.exec(part)?.[1] ?? "";
      const guests = (listed.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter((guest) => guest !== day.address);
      return { date: day.date, title: title.trim().toLowerCase(), guests };
    }),
  );
  return (change) => {
    const title = String(change?.title ?? "").trim().toLowerCase();
    const on = String(change?.start ?? "").slice(0, 10);
    const named = events.filter((event) => event.title === title && (!/^\d{4}-\d{2}-\d{2}$/.test(on) || event.date === on));
    return named.length === 0 ? null : [...new Set(named.flatMap((event) => event.guests))];
  };
}

/** The calendar days a range from `date` for `days` holds, as ISO dates. */
function datesFrom(date, days = 1) {
  const start = Date.parse(`${date}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/**
 * A calendar days answer with a check-in's own calendar events added on their days (`world.mjs` `calendarArrives`): a
 * check-in's calendar line is what the calendar holds for that day, read beside the fixture's days and never a made-up
 * one. `answer` is the calendar's days function (or null for none), `arrived` the events `{ date, text }`, and `address`
 * the calendar's address (a function, read when asked).
 */
export function withArrivedEvents(answer, arrived, address) {
  return async (body) => {
    const got = typeof answer === "function" ? await answer(body) : null;
    // Without arrivals the calendar answers as it did: no calendar connected when it has no days function.
    if (arrived.length === 0) return got ?? { ok: false, refused: "no_calendar" };
    const base = got?.ok === true ? got : { ok: true, days: [] };
    const wanted = new Set(datesFrom(body.date, body.days ?? 1));
    const extra = arrived.filter((event) => wanted.has(event.date));
    if (extra.length === 0) return base;
    const days = base.days.map((day) => ({ ...day }));
    for (const event of extra) {
      const line = `### ${event.text}`;
      const day = days.find((x) => x.date === event.date);
      if (day) day.text = day.text === "" ? line : `${day.text}\n\n${line}`;
      else days.push({ address: address() ?? "calendar@bench.invalid", date: event.date, text: line });
    }
    return { ...base, days: days.sort((a, b) => String(a.date).localeCompare(String(b.date))) };
  };
}

const VERBS = { create: "added", edit: "edited", move: "moved", cancel: "cancelled", rsvp: "answered" };

/**
 * The changes Tex made to the person's calendar, as change rows (`world.mjs` `changes()`), from the control plane's
 * calls: each create, edit, move, cancel or rsvp that was answered ok. A check (`check: true`) changed nothing and a
 * refused change changed nothing either, so neither is listed.
 */
export function calendarChanges(calls) {
  return calls
    .filter((entry) => entry.check !== true && entry.answer?.ok === true && VERBS[entry.change?.action])
    .map(({ change }) => {
      const when = change.start ? (change.action === "move" ? ` to ${change.start}` : change.action === "create" ? ` at ${change.start}` : "") : "";
      return { workspace: "calendar", path: "calendar", kind: change.action, detail: `${VERBS[change.action]} "${change.title ?? ""}"${when}` };
    });
}
