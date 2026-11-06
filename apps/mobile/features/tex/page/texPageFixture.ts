/**
 * The mock's example data (Dev2's approved v18), for the visual fixture and the
 * tests only. Never reachable in production: `app/e2e-fixture.tsx` renders
 * nothing unless the export set `EXPO_PUBLIC_E2E_FIXTURE`, and the product's
 * page reads only `gatewaySource`. Every name here is made up.
 *
 * `fixtureSource` behaves as the gateway does: actions change its copy and
 * push a live patch, so the fixture also shows an edit landing in place.
 */

import type { PatchFrame } from "./texPageLive";
import type { Read, TexPageSource } from "./texPageSource";
import type {
  AboutLine,
  AdvisorAsk,
  CheckIn,
  JobDetail,
  LedgerEntry,
  ListKind,
  ListPage,
  MailCheck,
  Overview,
  PageAction,
  Routine,
  Turn,
} from "./texPageTypes";

/** 6:10 pm on the fixture's day: every time below is read against it. */
export function fixtureNow(): number {
  const d = new Date(2026, 10, 2, 18, 10, 0, 0);
  return d.getTime();
}
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 10, 2 + dayOffset, h, m, 0, 0).getTime();

const ME_TURNS: Turn[] = [
  {
    at: at(18, 5),
    who: "You",
    said: "is maritime worth switching to?",
    thought: "Not sure on my own: it depends on how jobs restart and what a run costs. Ask the advisor, then answer in two lines.",
    did: [{ kind: "advisor", label: "Asked the Advisor", ref: "a1" }],
    reply: "Probably not yet, their restarts are manual",
    ms: 3800,
  },
  {
    at: at(17, 58),
    who: "You",
    said: "book us dinner friday, 6 people, somewhere near the office",
    thought: "A booking takes several sites and maybe a sign-in, so it's a job, not a quick answer. Give it to a free minion and say it's started.",
    did: [{ kind: "job", label: "Started Minion 2", ref: "dinner" }],
    reply: "On it, looking for a table for 6",
    ms: 1400,
  },
  {
    at: at(16, 12),
    who: "You",
    said: "move my 3 with sam to thursday",
    thought: "One 3 pm with Sam on the calendar, and Thursday 3 pm is free. Moving it tells Sam, so the email goes through the check first.",
    did: [
      { kind: "tool", label: "Moved the event" },
      { kind: "mailcheck", label: "Email check passed it", ref: "m2" },
    ],
    reply: "Done, Sam has the new time",
    ms: 2100,
  },
  {
    at: at(15, 40),
    who: "You",
    said: "what's on tomorrow",
    thought: "Read tomorrow's calendar and answer; nothing to hand off.",
    did: [{ kind: "tool", label: "Read calendar" }],
    reply: "Two calls, gym at 6:30",
    ms: 800,
  },
];

const GROUP_TURNS: Turn[] = [
  {
    at: at(18, 10),
    who: "Ada",
    said: "tex where should we eat friday, 6 of us",
    thought: "Same ask as the Friday dinner routine. Booking takes a few sites, so it's a job; tell Ada it's started.",
    did: [{ kind: "job", label: "Started Minion 1", ref: "gdinner" }],
    reply: "On it Ada, looking near the office",
    ms: 1600,
  },
  { at: at(18, 2), who: "Cy", said: "lol no not the sushi place again", thought: "Not to Tex and not a question for it. Stay quiet.", did: [], reply: null, ms: 500 },
  {
    at: at(17, 40),
    who: "You",
    said: "tex email the venue we picked",
    thought: "Email goes to someone outside the chat, so it goes through the check and waits for a yes from you, not anyone else here.",
    did: [{ kind: "mailcheck", label: "Email check held it", ref: "gm1" }, { kind: "tool", label: "asked you “Send it?”" }],
    reply: null,
    ms: 2400,
  },
];

const JOBS: Record<string, JobDetail> = {
  maritime: {
    id: "maritime",
    title: "Research maritime.sh for managing Tex's agents",
    state: "running",
    startedAt: at(18, 9),
    failedSteps: 3,
    slot: 1,
    now: "browse: maritime.sh/docs/agents",
    steps: [
      { at: at(18, 1), text: "Opened maritime.sh · tried twice", failed: true, why: "Try 1: the page took too long to load. Try 2: no browser was open by then." },
      { at: at(18, 2), text: "Opened 4 pages: pricing, GitHub and 2 more" },
      { at: at(18, 2), text: "Read 2 of your notes on Tex's setup" },
      { at: at(18, 2), text: "Asked the advisor what to compare" },
      { at: at(18, 2), text: "Opened maritime.sh/blog", failed: true, why: "The button it aimed for wasn't on the page any more." },
      { at: at(18, 3), text: "Now: reading maritime.sh/docs/agents" },
    ],
  },
  hello: {
    id: "hello",
    title: "Add hello.py to the demo repo",
    state: "running",
    startedAt: at(18, 5),
    failedSteps: 0,
    slot: 1,
    machine: "m-vm",
    machineName: "Cloud VM",
    ranOn: "On Cloud VM",
    tool: "Claude Code",
    steps: [
      { at: at(18, 5), text: "shell run git" },
      { at: at(18, 5), text: "files write hello.py" },
      { at: at(18, 6), text: "shell run python3" },
      { at: at(18, 6), text: "Done on Cloud VM · checking the work" },
    ],
  },
  dinner: {
    id: "dinner",
    title: "Book dinner for Friday",
    state: "waiting",
    startedAt: at(17, 58),
    failedSteps: 0,
    slot: 2,
    needs: "Needs your sign-in code",
    steps: [
      { at: at(17, 58), text: "Found 3 places with a table for 6 at 7:30" },
      { at: at(17, 59), text: "Opened resy.com to book Lucia's" },
      { at: at(18, 0), text: "Waiting: Resy texted you a sign-in code. Text it to Tex." },
    ],
  },
  florists: {
    id: "florists",
    title: "Compare three florists near Chelsea",
    state: "done",
    startedAt: at(17, 40),
    endedAt: at(17, 46),
    failedSteps: 0,
    steps: [
      { at: at(17, 40), text: "Searched for florists near Chelsea" },
      { at: at(17, 42), text: "Opened 3 florist sites for prices and hours" },
      { at: at(17, 46), text: "Saved a comparison page in your notes" },
    ],
    result: { summary: "8 steps, all worked", href: "/note/florists", label: "Open the page it made" },
  },
  sam: {
    id: "sam",
    title: "Moved your 3 pm with Sam to Thursday",
    state: "done",
    startedAt: at(16, 8),
    endedAt: at(16, 10),
    failedSteps: 0,
    steps: [{ at: at(16, 12), text: "Moved the event and told Sam" }],
  },
  gdinner: {
    id: "gdinner",
    title: "Booking dinner Friday",
    state: "running",
    startedAt: at(18, 7),
    failedSteps: 0,
    slot: 1,
    for: "Ada",
    steps: [{ at: at(18, 8), text: "Looking for a table for 6 near the office" }],
  },
  gplaces: { id: "gplaces", title: "Made a page comparing 4 places for Friday", state: "done", startedAt: at(17, 0), endedAt: at(17, 10), failedSteps: 0, steps: [] },
  gbill: { id: "gbill", title: "Split last week's dinner bill", state: "done", startedAt: at(15, 0), endedAt: at(15, 10), failedSteps: 0, steps: [] },
};

const summary = ({ steps: _s, result: _r, ...job }: JobDetail) => job;

const ADVISOR: AdvisorAsk[] = [
  {
    id: "a1",
    at: at(18, 2),
    job: "Researching maritime.sh",
    question: "What should I compare maritime.sh against for running Tex's agents?",
    answer: "Compare it on three things: how jobs restart after a crash, what a run costs per hour, and whether logs are kept. Skip the blog; the docs and pricing pages answer all three.",
    read: "Read the job so far · 6 steps",
    ms: 4000,
  },
  {
    id: "a2",
    at: at(17, 59),
    job: "Booking dinner Friday",
    question: "Resy wants a sign-in code. Can I get round it?",
    answer: "No. Ask the person for the code; don't try another account or site for the same table.",
    read: "Read the job so far · 3 steps",
    ms: 3000,
  },
];

const MAIL: MailCheck[] = [
  { id: "m1", at: at(18, 0), to: "Lucia's", subject: "Table for 6, Friday 7:30", verdict: "waiting", why: "It goes to someone new and books for a group, so it waits for you. Text yes to send.", from: "Booking dinner Friday" },
  { id: "m2", at: at(16, 13), to: "Sam", subject: "Moving our 3 pm to Thursday", verdict: "sent", why: "You asked for this in your text at 4:12, and the time matches your calendar.", from: "your texts" },
  { id: "m3", at: at(9, 20), to: "billing@", subject: "Cancel my plan", verdict: "stopped", why: "Nothing you said asked to cancel; Tex guessed from an old email. Told Tex to ask you first.", from: "Morning brief" },
];

const ROUTINES: Routine[] = [
  { id: "r1", title: "Morning brief", when: "Weekdays at 8:00", what: "your day, mail that matters", on: true },
  { id: "r2", title: "Friday dinner plan", when: "Fridays at 2:00 pm", what: "books a table for the group", on: true },
  { id: "r3", title: "Bill reminders", when: "1st of the month", what: "checks what's due", on: true },
  { id: "r4", title: "Gym nudge", when: "Mon, Wed at 6:30 am", on: false, pausedSince: "Oct 20" },
];

const CHECKINS: CheckIn[] = [
  { id: "c1", when: "Tonight at 9:30", what: "Ask how you slept, log it", at: at(21, 30) },
  { id: "c2", when: "Tomorrow at 1:00 pm", what: "Did Sam reply about Thursday?", at: at(13, 0, 1) },
  { id: "c3", when: "Today at 12:00", what: "Read mail and calendar", done: true, result: "nothing worth a text" },
];

const ABOUT: AboutLine[] = [
  { line: "l1", text: "You're on US Eastern time.", source: "From your texts", at: at(9, 0, -16) },
  { line: "l2", text: "Keep replies to two lines, plain words.", source: "You said so", at: at(9, 0, -1), isNew: true },
  { line: "l3", text: "Dinner on Fridays is usually for 6.", source: "Tex noticed", at: at(17, 0), isNew: true },
  { line: "l4", text: "You don't eat shellfish.", source: "From your texts", at: at(9, 0, -11) },
];

const GROUP_ABOUT: AboutLine[] = [
  { line: "g1", text: "Dinner on Fridays is for 6, near the office.", source: "Ada said so", at: at(9, 0, -9) },
  { line: "g2", text: "Cy doesn't eat sushi.", source: "Tex noticed", at: at(18, 3), isNew: true },
  { line: "g3", text: "Bills are split evenly unless someone says otherwise.", source: "You said so", at: at(9, 0, -3) },
];

interface Copy {
  overview: Overview;
  lists: { [K in ListKind]?: ListPage<K> };
  jobs: string[];
}

function meCopy(): Copy {
  return {
    overview: {
      chats: [
        { key: "me", name: "Just you" },
        { key: "g-team", name: "Team Night", people: 5 },
        { key: "g-care", name: "Crystal Care", people: 3 },
      ],
      chat: { key: "me", name: "Just you" },
      status: { jobs: 2, needsYou: 1 },
      thinking: ME_TURNS.slice(0, 3),
      thinkingToday: 6,
      minions: [
        { slot: 1, job: { ...summary(JOBS.maritime!), title: "Researching maritime.sh" } },
        { slot: 2, job: { ...summary(JOBS.dinner!), title: "Booking dinner Friday" } },
        { slot: 3, job: null },
      ],
      earlier: [{ ...summary(JOBS.florists!), title: "Compared three florists near Chelsea", endedAt: fixtureNow() - 20 * 60_000 }, { ...summary(JOBS.sam!), endedAt: fixtureNow() - 2 * 3_600_000 }],
      earlierWeek: 7,
      tiles: {
        routines: { on: 3, next: "8:00" },
        checkins: { next: "9:30 pm" },
        about: { count: 24, newToday: 2 },
        computer: { running: true, url: "https://maritime.sh/docs/agents" },
        settings: { summary: "Friendly · short" },
      },
      behind: { advisor: { today: 2, last: "what to compare on maritime.sh" }, mailcheck: { today: 3, waiting: 1 } },
    },
    lists: {
      thinking: { items: ME_TURNS },
      jobs: { items: [summary(JOBS.florists!), summary(JOBS.sam!)] },
      advisor: { items: ADVISOR },
      mailcheck: { items: MAIL },
      routines: { items: ROUTINES },
      checkins: { items: CHECKINS, looksAt: ["Gmail", "calendar", "notes", "Slack"], quietHours: "11 pm to 7 am" },
      about: { items: ABOUT, total: 24 },
      settings: {
        items: [],
        instructions: "Be friendly.\nUse emoji sparingly.\nKeep answers short: the answer and nothing more.",
        picks: [{ id: "friendly", label: "Friendly" }, { id: "emoji_none", label: "No emoji" }, { id: "short", label: "Short answers" }],
        number: "+1 (555) 010-0199",
      },
    },
    jobs: ["maritime", "dinner", "florists", "sam", "hello"],
  };
}

function groupCopy(key: string, name: string): Copy {
  const chat = { key, name, people: 5 };
  return {
    overview: {
      chats: meCopy().overview.chats,
      chat,
      status: { jobs: 1, needsYou: 0 },
      thinking: GROUP_TURNS,
      thinkingToday: 14,
      minions: [
        { slot: 1, job: summary(JOBS.gdinner!) },
        { slot: 2, job: null },
        { slot: 3, job: null },
      ],
      earlier: [{ ...summary(JOBS.gplaces!), endedAt: fixtureNow() - 3_600_000 }, { ...summary(JOBS.gbill!), endedAt: fixtureNow() - 3 * 3_600_000 }],
      earlierWeek: 2,
      tiles: {
        routines: { on: 1, next: "Fri 2 pm" },
        checkins: {},
        about: { count: 12, newToday: 0 },
        computer: { running: true, url: "https://resy.com/" },
        settings: { summary: "Answers when named" },
      },
      behind: { advisor: { today: 0 }, mailcheck: { today: 0, waiting: 1 } },
    },
    lists: {
      thinking: { items: GROUP_TURNS },
      jobs: { items: [summary(JOBS.gplaces!), summary(JOBS.gbill!)] },
      advisor: { items: [] },
      mailcheck: { items: [{ ...MAIL[0]!, id: "gm1", to: "the venue", subject: "Booking for Friday" }] },
      routines: { items: [ROUTINES[1]!] },
      checkins: { items: [] },
      about: { items: GROUP_ABOUT, total: 12 },
      settings: { items: [], values: { answers: "named" }, instructions: "", picks: [{ id: "friendly", label: "Friendly" }, { id: "emoji_none", label: "No emoji" }, { id: "short", label: "Short answers" }], approver: "You", people: ["You", "Ada", "Cy", "Bo", "Mia"] },
    },
    jobs: ["gdinner", "gplaces", "gbill"],
  };
}

/** A day as the gateway reads one, on this device's calendar. */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The chat's history file, as the gateway keeps it: yesterday's check-in and a few of the morning's entries. */
function ledgerOf(chat: string): LedgerEntry[] {
  const turn = `${chat}-t1`;
  const from = chat === "me" ? { kind: "person" } : { kind: "person", name: "Ada" };
  const yesterday = [
    { v: 1, seq: 1, id: `${chat}-y1`, at: at(7, 58, -1), kind: "note", turn: `${chat}-t0`, text: "morning check-in ran" },
    { v: 1, seq: 2, id: `${chat}-y2`, at: at(7, 58, -1), kind: "text", from: { kind: "tex" }, turn: `${chat}-t0`, text: "Morning. Your water bill is due Tuesday." },
  ];
  // A group's people react and answer one another, Tex or not.
  const people =
    chat === "me"
      ? []
      : [
          { v: 1, seq: 9, id: `${chat}-e7`, at: at(9, 4), kind: "text", event: "reaction", from: { kind: "person", name: "Cy" }, text: "👍" },
          { v: 1, seq: 10, id: `${chat}-e8`, at: at(9, 5), kind: "text", eid: `${chat}-w8`, replyTo: `${chat}-w1`, from: { kind: "person", name: "Bo" }, text: "I'll bring snacks to standup" },
        ];
  // A job's turn writes into the chat's history like any turn, each entry marked with the job; the history folds it under the job's line.
  const jobTag = { turn: `${chat}-tj`, jobId: "maritime", jobTitle: "Research maritime.sh" };
  const jobWork =
    chat === "me"
      ? [
          { v: 1, seq: 11, id: "me-j1", at: at(9, 10), kind: "thinking", ...jobTag, text: "Read their docs, then compare pricing." },
          { v: 1, seq: 12, id: "me-j2", at: at(9, 10), kind: "tool", ...jobTag, name: "browse", ok: true, ms: 900 },
          { v: 1, seq: 13, id: "me-j3", at: at(9, 11), kind: "tool", ...jobTag, name: "browse", ok: false, ms: 900 },
          { v: 1, seq: 14, id: "me-j4", at: at(9, 12), kind: "tool", ...jobTag, name: "ask_advisor", ok: true, ms: 4000, result: "Pricing page is the one to read; skip the blog.", thinking: "They want cost first. The blog is old." },
          { v: 1, seq: 15, id: "me-j5", at: at(9, 12), kind: "job", ...jobTag, job: "maritime", title: "Research maritime.sh", state: "keep_going" },
        ]
      : [];
  return [
    ...yesterday.map((e) => ({ ...e, seq: e.seq - 2 })),
    { v: 1, seq: 1, id: `${chat}-e1`, at: at(9, 2), kind: "text", eid: `${chat}-w1`, from, text: "what's on my calendar today?" },
    { v: 1, seq: 2, id: `${chat}-e2`, at: at(9, 2), kind: "thinking", turn, text: "Look at today's calendar, then answer in a line." },
    { v: 1, seq: 3, id: `${chat}-e3`, at: at(9, 2), kind: "tool", turn, name: "calendar_events", args: { day: "today" }, ok: true, ms: 420, result: "2 events" },
    { v: 1, seq: 4, id: `${chat}-e4`, at: at(9, 3), kind: "tool", turn, name: "read_note", args: { context: "@elsewhere" }, ok: true, ms: 180, withheld: "other_workspace" },
    { v: 1, seq: 5, id: `${chat}-e5`, at: at(9, 3), kind: "reply", turn, text: "Standup at 10 and the dentist at 3.", ms: 2100, clean: true },
    { v: 1, seq: 6, id: `${chat}-e6`, at: at(9, 3), kind: "text", from: { kind: "tex" }, turn, text: "Standup at 10 and the dentist at 3.", delivered: true },
    ...people,
    ...jobWork,
  ];
}

/** An in-memory gateway with the mock's data; actions change it and patch every open feed. */
export function fixtureSource(): TexPageSource {
  const copies = new Map<string, Copy>([
    ["me", meCopy()],
    ["g-team", groupCopy("g-team", "Team Night")],
    ["g-care", groupCopy("g-care", "Crystal Care")],
  ]);
  const feeds = new Set<{ chat: string; onPatch: (p: PatchFrame) => void }>();
  const push = (chat: string, patch: PatchFrame) => {
    for (const f of feeds) if (f.chat === chat) f.onPatch(patch);
  };
  const ok = <T>(value: T): Read<T> => ({ kind: "ok", value: JSON.parse(JSON.stringify(value)) as T });

  return {
    async overview(chat) {
      const c = copies.get(chat);
      return c ? ok(c.overview) : { kind: "notYours" };
    },
    async job(chat, id) {
      const c = copies.get(chat);
      const job = JOBS[id];
      return c && job && c.jobs.includes(id) ? ok(job) : { kind: "notYours" };
    },
    async list(chat, kind) {
      const c = copies.get(chat);
      if (!c) return { kind: "notYours" };
      return ok((c.lists[kind] ?? { items: [] }) as ListPage<typeof kind>);
    },
    async ledger(chat, query) {
      if (!copies.has(chat)) return { kind: "notYours" };
      const entries = ledgerOf(chat).filter(
        (e) =>
          (!query.kinds || query.kinds.includes(e.kind as never)) &&
          (!query.day || query.day === dayOf(e.at)) &&
          (query.job === undefined || e.jobId === query.job || (e.kind === "job" && e.job === query.job)) &&
          (query.jobs !== false || e.jobId === undefined),
      );
      // As the gateway reads with `before`: newest first.
      const before = query.before ?? Number.MAX_SAFE_INTEGER;
      return ok({ manifest: { schema: "tex-ledger", version: 1, count: 6, created: at(9, 2), updated: at(9, 3) }, entries: entries.filter((e) => (e.seq ?? 0) < before).reverse() });
    },
    async machines() {
      // The mock's gateway predates machines, so it answers as such a gateway does.
      return { kind: "notYours" };
    },
    async sees(chat) {
      if (!copies.has(chat)) return { kind: "notYours" };
      const group = chat !== "me";
      return ok({
        settings: { thinking: false, toolNames: true, toolResults: false, budgetChars: 48000, lastDayFrom: "texting Worker", before: "ledger" },
        text: `[9:02 AM] ${group ? "Ada" : "You"}: what's on my calendar today?\n[9:03 AM] Tex: Standup at 10 and the dentist at 3.\n  (used: calendar_events, read_note)`,
      });
    },
    async act(chat, action: PageAction) {
      const c = copies.get(chat);
      if (!c) return { ok: false, error: "not_yours" };
      const routines = c.lists.routines?.items ?? [];
      const checkins = c.lists.checkins?.items ?? [];
      const about = c.lists.about?.items ?? [];
      switch (action.type) {
        case "routine.toggle":
          for (const r of routines) if (r.id === action.id) r.on = action.on;
          push(chat, { section: "routines" });
          break;
        case "routine.remove":
          c.lists.routines = { items: routines.filter((r) => r.id !== action.id) };
          push(chat, { section: "routines" });
          break;
        case "checkin.edit":
          // As the gateway does: only what was sent changes; a new time is shown as it was typed.
          for (const x of checkins)
            if (x.id === action.id) Object.assign(x, action.when ? { when: action.when } : {}, action.what ? { what: action.what } : {});
          push(chat, { section: "checkins" });
          break;
        case "checkin.cancel":
          c.lists.checkins = { ...c.lists.checkins, items: checkins.filter((x) => x.id !== action.id) };
          push(chat, { section: "checkins" });
          break;
        case "checkin.add":
          checkins.unshift({ id: `c${Date.now()}`, when: action.when, what: action.what });
          push(chat, { section: "checkins" });
          break;
        case "about.fix":
          for (const l of about) if (l.line === action.line) l.text = action.text;
          push(chat, { section: "about" });
          break;
        case "about.remove":
          c.lists.about = { ...c.lists.about, items: about.filter((l) => l.line !== action.line) };
          push(chat, { section: "about" });
          break;
        case "settings":
        case "group.settings": {
          const s = c.lists.settings!;
          const { instructions, pick, ...rest } = action.values;
          if (typeof instructions === "string") s.instructions = instructions;
          if (typeof pick === "string") s.instructions = [s.instructions, s.picks?.find((p) => p.id === pick)?.label].filter(Boolean).join("\n");
          if (Object.keys(rest).length) s.values = { ...s.values, ...rest };
          push(chat, { section: "settings" });
          break;
        }
        default:
          push(chat, { section: "jobs" });
      }
      return { ok: true };
    },
    live(chat, onPatch, onLive) {
      const feed = { chat, onPatch };
      feeds.add(feed);
      setTimeout(() => onLive(true), 0);
      return {
        watch(next) {
          feed.chat = next;
        },
        close() {
          feeds.delete(feed);
        },
      };
    },
  };
}
