/**
 * The gateway's answers, field by field. Pure, so tests walk every shape.
 *
 * Anything missing or mistyped reads as empty: a section whose records do not
 * exist yet answers `[]` or 0, and the page draws it as empty rather than
 * failing. Nothing here invents a value the gateway did not send.
 */

import type {
  AboutLine,
  AdvisorAsk,
  Behind,
  ChatRef,
  CheckIn,
  JobDetail,
  JobState,
  JobStep,
  JobSummary,
  ListKind,
  ListPage,
  MailCheck,
  Overview,
  Routine,
  Slot,
  Tiles,
  Turn,
  TurnAction,
} from "./texPageTypes";
import type { SlotPlace } from "./texMachineTypes";
import { readAsks, readPlaces } from "./texMachineRead";

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const list = <T>(v: unknown, read: (x: unknown) => T | null): T[] =>
  arr(v)
    .map(read)
    .filter((x): x is T => x !== null);

export function readChat(v: unknown): ChatRef | null {
  const r = rec(v);
  const key = str(r?.key);
  if (!r || !key) return null;
  const home = rec(r.home);
  const context = str(home?.context);
  const folder = str(home?.folder);
  return {
    key,
    name: str(r.name) ?? key,
    ...(num(r.people) !== undefined ? { people: num(r.people) } : {}),
    ...(context && folder ? { home: { context, folder } } : {}),
  };
}

const ACTION_KINDS = new Set(["advisor", "job", "mailcheck", "tool"]);

function readAction(v: unknown): TurnAction | null {
  const r = rec(v);
  const label = str(r?.label);
  if (!r || !label) return null;
  const kind = ACTION_KINDS.has(r.kind as string) ? (r.kind as TurnAction["kind"]) : "tool";
  return { kind, label, ...(str(r.ref) ? { ref: str(r.ref) } : {}) };
}

export function readTurn(v: unknown): Turn | null {
  const r = rec(v);
  if (!r) return null;
  const at = num(r.at);
  if (at === undefined) return null;
  const reply = str(r.reply);
  return {
    at,
    who: str(r.who) ?? "",
    said: str(r.said) ?? "",
    thought: str(r.thought) ?? "",
    did: list(r.did, readAction),
    reply: reply === undefined || reply === "" ? null : reply,
    ms: num(r.ms) ?? 0,
  };
}

const JOB_STATES = new Set(["running", "waiting", "done", "failed", "stopped"]);

export function readJob(v: unknown): JobSummary | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id) return null;
  const state = JOB_STATES.has(r.state as string) ? (r.state as JobState) : "running";
  const job: JobSummary = {
    id,
    title: str(r.title) ?? "",
    state,
    startedAt: num(r.startedAt) ?? 0,
    failedSteps: num(r.failedSteps) ?? 0,
  };
  const endedAt = num(r.endedAt);
  if (endedAt !== undefined) job.endedAt = endedAt;
  for (const key of ["needs", "for", "now", "ranOn", "tool"] as const) {
    const s = str(r[key]);
    if (s) job[key] = s;
  }
  const slot = num(r.slot);
  if (slot !== undefined) job.slot = slot;
  return job;
}

function readStep(v: unknown): JobStep | null {
  const r = rec(v);
  const text = str(r?.text);
  if (!r || text === undefined) return null;
  const step: JobStep = { at: num(r.at) ?? 0, text };
  if (r.failed === true) step.failed = true;
  const why = str(r.why);
  if (why) step.why = why;
  return step;
}

/** A link the page may open: a path in the app, or an https address. Never `javascript:`, never `//host`. */
export function safeHref(href: string): boolean {
  if (/^\/(?!\/)/.test(href)) return !href.includes("\\");
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

export function readJobDetail(v: unknown): JobDetail | null {
  const r = rec(v);
  const job = readJob(r);
  if (!r || !job) return null;
  const detail: JobDetail = { ...job, steps: list(r.steps, readStep) };
  const res = rec(r.result);
  if (res) {
    detail.result = {};
    for (const key of ["summary", "label"] as const) {
      const s = str(res[key]);
      if (s) detail.result[key] = s;
    }
    const href = str(res.href);
    if (href && safeHref(href)) detail.result.href = href;
  }
  return detail;
}

function readSlots(v: unknown, places?: SlotPlace[]): Slot[] {
  const given = arr(v)
    .map((x) => rec(x))
    .filter((x): x is Rec => x !== null);
  // Always three slots, 1 to 3, whatever the gateway sent: a slot nobody filled is free.
  if (!places) {
    return [1, 2, 3].map((slot) => {
      const found = given.find((g) => num(g.slot) === slot && g.place === undefined);
      return { slot, job: found ? readJob(found.job) : null };
    });
  }
  // With places, each place has exactly its own count of slots, numbered from 1.
  return places.flatMap((p) =>
    Array.from({ length: p.slots }, (_, i) => {
      const slot = i + 1;
      const found = given.find((g) => num(g.slot) === slot && g.place === p.key);
      return { slot, place: p.key, job: found ? readJob(found.job) : null };
    }),
  );
}

function readTiles(v: unknown): Tiles {
  const r = rec(v) ?? {};
  const routines = rec(r.routines) ?? {};
  const checkins = rec(r.checkins) ?? {};
  const about = rec(r.about) ?? {};
  const computer = rec(r.computer) ?? {};
  const settings = rec(r.settings) ?? {};
  const next = (v: unknown) => str(v) ?? num(v);
  const rNext = next(routines.next);
  const cNext = next(checkins.next);
  return {
    routines: { on: num(routines.on) ?? 0, ...(rNext !== undefined ? { next: rNext } : {}) },
    checkins: cNext !== undefined ? { next: cNext } : {},
    about: { count: num(about.count) ?? 0, newToday: num(about.newToday) ?? 0 },
    computer: { running: computer.running === true, ...(str(computer.url) ? { url: str(computer.url) } : {}) },
    settings: { summary: str(settings.summary) ?? "" },
  };
}

function readBehind(v: unknown): Behind {
  const r = rec(v) ?? {};
  const advisor = rec(r.advisor) ?? {};
  const mail = rec(r.mailcheck) ?? {};
  return {
    advisor: { today: num(advisor.today) ?? 0, ...(str(advisor.last) ? { last: str(advisor.last) } : {}) },
    mailcheck: { today: num(mail.today) ?? 0, waiting: num(mail.waiting) ?? 0 },
  };
}

export const EMPTY_OVERVIEW: Overview = {
  chats: [{ key: "me", name: "Just you" }],
  chat: { key: "me", name: "Just you" },
  status: { jobs: 0, needsYou: 0 },
  thinking: [],
  thinkingToday: 0,
  minions: readSlots([]),
  earlier: [],
  earlierWeek: 0,
  tiles: readTiles(null),
  behind: readBehind(null),
};

/** One overview section, by name: what a live patch carries. */
export function readSection(overview: Overview, section: string, value: unknown): Overview | null {
  switch (section) {
    case "chats": {
      const chats = list(value, readChat);
      return chats.length ? { ...overview, chats } : overview;
    }
    case "status": {
      const r = rec(value) ?? {};
      return { ...overview, status: { jobs: num(r.jobs) ?? 0, needsYou: num(r.needsYou) ?? 0 } };
    }
    case "thinking":
      return { ...overview, thinking: list(value, readTurn).slice(0, 3) };
    case "thinkingToday":
      return { ...overview, thinkingToday: num(value) ?? 0 };
    case "minions":
      return { ...overview, minions: readSlots(value, overview.places) };
    case "places": {
      const places = readPlaces(value);
      const { places: _old, ...rest } = overview;
      return places ? { ...rest, places } : rest;
    }
    case "asks":
      // Absent means a gateway without machines: no key, as with `places`.
      return Array.isArray(value) ? { ...overview, asks: readAsks(value) } : overview;
    case "earlier":
      return { ...overview, earlier: list(value, readJob).slice(0, 2) };
    case "earlierWeek":
      return { ...overview, earlierWeek: num(value) ?? 0 };
    case "tiles":
      return { ...overview, tiles: readTiles(value) };
    case "behind":
      return { ...overview, behind: readBehind(value) };
    default:
      return null;
  }
}

export function readOverview(v: unknown): Overview | null {
  const r = rec(v);
  if (!r) return null;
  const chat = readChat(r.chat) ?? EMPTY_OVERVIEW.chat;
  const chats = list(r.chats, readChat);
  let out: Overview = { ...EMPTY_OVERVIEW, chat, chats: chats.length ? chats : [chat] };
  for (const key of ["places", "asks", "status", "thinking", "thinkingToday", "minions", "earlier", "earlierWeek", "tiles", "behind"]) {
    out = readSection(out, key, r[key]) ?? out;
  }
  return out;
}

function readAdvisor(v: unknown): AdvisorAsk | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    at: num(r.at) ?? 0,
    ...(str(r.job) ? { job: str(r.job) } : {}),
    question: str(r.question) ?? "",
    answer: str(r.answer) ?? "",
    read: str(r.read) ?? "",
    ms: num(r.ms) ?? 0,
  };
}

const VERDICTS = new Set(["sent", "waiting", "stopped"]);

function readMail(v: unknown): MailCheck | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id || !VERDICTS.has(r.verdict as string)) return null;
  return {
    id,
    at: num(r.at) ?? 0,
    to: str(r.to) ?? "",
    subject: str(r.subject) ?? "",
    verdict: r.verdict as MailCheck["verdict"],
    why: str(r.why) ?? "",
    from: str(r.from) ?? "",
  };
}

function readRoutine(v: unknown): Routine | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    title: str(r.title) ?? "",
    when: str(r.when) ?? "",
    ...(str(r.what) ? { what: str(r.what) } : {}),
    on: r.on !== false,
    ...(str(r.pausedSince) ? { pausedSince: str(r.pausedSince) } : {}),
  };
}

function readCheckIn(v: unknown): CheckIn | null {
  const r = rec(v);
  const id = str(r?.id);
  if (!r || !id) return null;
  return {
    id,
    when: str(r.when) ?? "",
    what: str(r.what) ?? "",
    ...(r.done === true ? { done: true } : {}),
    ...(str(r.result) ? { result: str(r.result) } : {}),
    ...(num(r.at) !== undefined ? { at: num(r.at) } : {}),
  };
}

function readAbout(v: unknown): AboutLine | null {
  const r = rec(v);
  const line = str(r?.line);
  if (!r || !line) return null;
  return {
    line,
    text: str(r.text) ?? "",
    source: str(r.source) ?? "",
    at: num(r.at) ?? 0,
    ...(r.isNew === true ? { isNew: true } : {}),
  };
}

const READERS: { [K in ListKind]: (v: unknown) => unknown } = {
  thinking: readTurn,
  jobs: readJob,
  advisor: readAdvisor,
  mailcheck: readMail,
  routines: readRoutine,
  checkins: readCheckIn,
  about: readAbout,
  settings: () => null,
};

export function readList<K extends ListKind>(kind: K, v: unknown): ListPage<K> {
  const r = rec(v) ?? {};
  const page = { items: list(r.items, READERS[kind]) } as ListPage<K>;
  if (str(r.cursor)) page.cursor = str(r.cursor);
  const looksAt = arr(r.looksAt).filter((x): x is string => typeof x === "string");
  if (looksAt.length) page.looksAt = looksAt;
  if (str(r.quietHours)) page.quietHours = str(r.quietHours);
  if (num(r.total) !== undefined) page.total = num(r.total);
  const values = rec(r.values);
  if (values) {
    page.values = {};
    for (const [k, x] of Object.entries(values)) if (typeof x === "string" || typeof x === "number") page.values[k] = x;
  }
  if (typeof r.instructions === "string") page.instructions = r.instructions;
  const picks = arr(r.picks).flatMap((x) => {
    const p = rec(x);
    return p && str(p.id) && str(p.label) ? [{ id: str(p.id)!, label: str(p.label)! }] : [];
  });
  if (picks.length) page.picks = picks;
  if (str(r.number)) page.number = str(r.number);
  if (str(r.approver)) page.approver = str(r.approver);
  const people = arr(r.people).filter((x): x is string => typeof x === "string");
  if (people.length) page.people = people;
  return page;
}
