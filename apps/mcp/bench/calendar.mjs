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
  const flags = { calendarDays: calendarAnswer(days), ...calendarWrites(days) };
  if (connectedFor === null) return flags;
  // Connected with a fixture's days: their own calendar takes their changes too. Without this a fixture whose days
  // name no guests could be read but not changed, and every add was refused as no calendar connected.
  if (days.length > 0) return { calendarAddress: days[0].address, ...flags };
  const address = `${String(connectedFor).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@calendar.bench.invalid`;
  return { ...flags, calendarDays: () => ({ ok: true, days: [] }), calendarAddress: address };
}
