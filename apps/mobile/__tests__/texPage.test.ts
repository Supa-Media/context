/**
 * The Tex page's data layer, without a renderer: the gateway's answers read
 * field by field, the mock's wording, the address, and the live socket.
 * `texPageRender.test.ts` mounts the page itself.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-02):
 *  1. `readAnswer` reading a 404 as `failed` → "another person's group is
 *     refused exactly as a missing one is" fails.
 *  2. `liveProtocols` putting the token in the URL instead → "the grant rides
 *     as a subprotocol, never in the address" fails.
 *  3. `openLive` dropping the watch frame on reconnect → "a reconnect says
 *     the chat again" fails.
 *  4. `readOverview` passing `thinking` through unread → "an overview is read
 *     field by field" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { EMPTY_OVERVIEW, readJobDetail, readList, readOverview, readSection } from "../features/tex/page/texPageRead";
import {
  actionPieces,
  advisorLine,
  ago,
  busyLine,
  minionMood,
  clock,
  endedLine,
  heading,
  mailcheckLine,
  seconds,
  slotLine,
  statusLine,
  tileLines,
  whenField,
  isWhenField,
  turnTail,
} from "../features/tex/page/texPageFormat";
import { liveProtocols, liveSocketUrl, openLive, readPatch, type SocketLike } from "../features/tex/page/texPageLive";
import { gatewaySource, readAnswer, texPageUrl } from "../features/tex/page/texPageSource";
import { addressOf, chatOfWords, placeHref, readPlace, signInHref } from "../features/tex/page/texPlace";
import { draftReason, onSite } from "../features/tex/page/texPageFormat";
import type { JobSummary } from "../features/tex/page/texPageTypes";

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: "j", title: "T", state: "running", startedAt: 0, failedSteps: 0, ...over });

describe("reading the gateway", () => {
  test("an overview is read field by field", () => {
    const o = readOverview({
      chat: { key: "me", name: "Just you" },
      chats: [{ key: "me", name: "Just you" }, { key: "g1", name: "Team", people: 5 }, { nope: 1 }],
      status: { jobs: 2, needsYou: "1" },
      thinking: [{ at: 1, who: "You", said: "hi", thought: "t", did: [{ kind: "bogus", label: "x" }], reply: "", ms: 10, extra: "<b>" }, { at: "x" }],
      minions: [{ slot: 2, job: { id: "a", title: "A", state: "waiting", startedAt: 5, failedSteps: 0 } }],
      tiles: { routines: { on: 3, next: "8:00" } },
      secret: "kept out",
    });
    expect(o).not.toBeNull();
    expect(o!.chats.map((c) => c.key)).toEqual(["me", "g1"]);
    expect(o!.status).toEqual({ jobs: 2, needsYou: 0 });
    expect(o!.thinking).toEqual([{ at: 1, who: "You", said: "hi", thought: "t", did: [{ kind: "tool", label: "x" }], reply: null, ms: 10 }]);
    expect(o!.minions.map((s) => [s.slot, s.job?.id ?? null])).toEqual([
      [1, null],
      [2, "a"],
      [3, null],
    ]);
    expect(o!.tiles.routines).toEqual({ on: 3, next: "8:00" });
    expect(o!.earlier).toEqual([]);
    expect(JSON.stringify(o)).not.toContain("kept out");
  });

  test("a job on a computer gets that computer's place beside Tex's cloud, and keeps its name", () => {
    const vm = { id: "v", title: "Add hello.py", state: "running", startedAt: 1, machine: "mch_1", machineName: "Cloud VM", ranOn: "On Cloud VM", tool: "Claude Code" };
    const o = readOverview({ minions: [{ slot: 1, job: null }, { slot: 1, place: "mch_1", job: vm }] })!;
    expect(o.places?.map((p) => [p.key, p.name, p.slots])).toEqual([
      ["cloud", "Tex's cloud", 3],
      ["mch_1", "Cloud VM", 1],
    ]);
    expect(o.minions.map((s) => [s.place, s.slot, s.job?.id ?? null])).toEqual([
      ["cloud", 1, null],
      ["cloud", 2, null],
      ["cloud", 3, null],
      ["mch_1", 1, "v"],
    ]);
    expect(o.minions[3]!.job).toMatchObject({ ranOn: "On Cloud VM", tool: "Claude Code", machine: "mch_1" });
    // Nobody with a computer: no places, the three slots as always.
    expect(readOverview({ minions: [{ slot: 2, job: { id: "a" } }] })!.places).toBeUndefined();
  });

  test("a minion card is the calm # Tex whatever its job's state, dimmed when free", () => {
    for (const state of ["running", "waiting", "failed", "done"] as const) expect(minionMood(job({ state }))).toBe("calm");
    expect(minionMood(null)).toBe("rest");
  });

  test("an offline computer's free slots are not counted as room", () => {
    const places = [
      { key: "cloud", kind: "cloud" as const, name: "Tex's cloud", slots: 3 },
      { key: "vm", kind: "machine" as const, name: "Cloud VM", slots: 2 },
      { key: "mac", kind: "machine" as const, name: "MacBook Pro", slots: 2, offline: true },
    ];
    const slots = places.flatMap((p) => Array.from({ length: p.slots }, (_, i) => ({ slot: i + 1, place: p.key, job: p.key === "vm" && i === 0 ? job() : null })));
    expect(busyLine(slots, places)).toBe("Minions · 1 of 5 busy");
  });

  test("a section not sent yet answers empty, never an error", () => {
    expect(readOverview({})).toEqual(EMPTY_OVERVIEW);
    expect(readList("routines", {})).toEqual({ items: [] });
    expect(readList("about", null)).toEqual({ items: [] });
  });

  test("a live patch replaces one section and nothing else", () => {
    const next = readSection(EMPTY_OVERVIEW, "status", { jobs: 1, needsYou: 1 });
    expect(next!.status).toEqual({ jobs: 1, needsYou: 1 });
    expect(next!.thinking).toBe(EMPTY_OVERVIEW.thinking);
    expect(readSection(EMPTY_OVERVIEW, "nope", 1)).toBeNull();
    expect(readSection(EMPTY_OVERVIEW, "thinking", [1, 2, 3, 4].map((at) => ({ at })))!.thinking).toHaveLength(3);
  });

  test("a job's steps keep only what a step is", () => {
    const j = readJobDetail({ id: "a", title: "A", state: "failed", startedAt: 1, failedSteps: 1, steps: [{ at: 2, text: "x", failed: "yes", why: "w" }, { at: 3 }], result: { href: "/note/x", js: 1 } });
    expect(j!.steps).toEqual([{ at: 2, text: "x", why: "w" }]);
    expect(j!.result).toEqual({ href: "/note/x" });
  });

  test("a job's result link is a path in the app or https, nothing else", () => {
    const href = (h: string) => readJobDetail({ id: "a", steps: [], result: { href: h } })!.result!.href;
    expect(href("/note/x")).toBe("/note/x");
    expect(href("https://example.test/x")).toBe("https://example.test/x");
    for (const bad of ["javascript:alert(1)", "//evil.test/x", "/\\evil.test", "http://example.test", "data:text/html,x"]) expect(href(bad)).toBeUndefined();
  });

  test("an email check with an unknown verdict is not shown as one", () => {
    const page = readList("mailcheck", { items: [{ id: "1", verdict: "maybe" }, { id: "2", verdict: "sent", to: "Sam" }] });
    expect(page.items.map((m) => m.id)).toEqual(["2"]);
  });

  test("another person's group is refused exactly as a missing one is", () => {
    expect(readAnswer(404, { error: "not_found" }, readOverview)).toEqual({ kind: "notYours" });
    expect(readAnswer(403, { error: "not_yours" }, readOverview)).toEqual({ kind: "notYours" });
    expect(readAnswer(403, { error: "scope" }, readOverview)).toEqual({ kind: "failed" });
    expect(readAnswer(500, {}, readOverview)).toEqual({ kind: "failed" });
  });

  test("routes are the gateway's own origin, http or https only", () => {
    expect(texPageUrl("https://mcp.example.test/mcp", "")).toBe("https://mcp.example.test/tex/page");
    expect(texPageUrl("https://mcp.example.test/mcp", "act")).toBe("https://mcp.example.test/tex/page/act");
    expect(texPageUrl("javascript:alert(1)", "")).toBeNull();
  });

  test("a refused grant is replaced once, never in a loop", async () => {
    const tokens: unknown[] = [];
    let calls = 0;
    const source = gatewaySource({
      endpoint: "https://mcp.example.test/mcp",
      handle: "ada",
      token: async (refresh) => {
        tokens.push(refresh);
        return `t${tokens.length}`;
      },
      fetch: (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls += 1;
        expect(JSON.parse(init.body)).toEqual({ handle: "ada", chat: "me" });
        return { status: 401, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    expect(await source.overview("me")).toEqual({ kind: "failed" });
    expect(calls).toBe(2);
    expect(tokens).toEqual([false, { rejected: "t1" }]);
  });
});

describe("the mock's words", () => {
  test("header", () => {
    expect(heading({ key: "me", name: "Just you" })).toBe("Tex");
    expect(heading({ key: "g", name: "Team Night" })).toBe("Tex in Team Night");
    expect(statusLine({ chat: { key: "me", name: "" }, status: { jobs: 2, needsYou: 1 } })).toBe("Working on 2 jobs · 1 needs you");
    expect(statusLine({ chat: { key: "g", name: "", people: 5 }, status: { jobs: 1, needsYou: 0 } })).toBe("5 people · working on 1 job");
    expect(statusLine({ chat: { key: "me", name: "" }, status: { jobs: 0, needsYou: 0 } })).toBe("Nothing running right now");
  });

  test("minions", () => {
    expect(busyLine([{ slot: 1, job: job() }, { slot: 2, job: job() }, { slot: 3, job: null }])).toBe("Minions · 2 of 3 busy");
    expect(slotLine(job({ failedSteps: 3 }), 60_000)).toEqual({ text: "Thinking · 1\u00a0min", failed: "3 steps didn't work" });
    expect(slotLine(job({ state: "waiting", needs: "Needs your sign-in code" }))).toEqual({ text: "Needs your sign-in code", warn: true });
    expect(slotLine(job({ for: "Ada", now: "search_web: flights" }), 180_000)).toEqual({ text: "Researching · For Ada · 3\u00a0min" });
    expect(endedLine(job({ state: "done", endedAt: 0 }), 20 * 60_000)).toBe("Done · 20 min ago ›");
    expect(ago(0, 2 * 3_600_000)).toBe("2 h ago");
  });

  test("behind the scenes", () => {
    expect(advisorLine({ today: 2, last: "what to compare on maritime.sh" })).toBe("Helped twice today · last: what to compare on maritime.sh");
    expect(advisorLine({ today: 0 })).toBe("Not needed today");
    expect(mailcheckLine({ today: 3, waiting: 1 })).toBe("Checked 3 emails today · 1 waiting for your yes");
    expect(mailcheckLine({ today: 0, waiting: 1 })).toBe("1 email waiting for your yes");
  });

  test("tiles", () => {
    const t = tileLines(
      { routines: { on: 3, next: "8:00" }, checkins: { next: "9:30 pm" }, about: { count: 24, newToday: 2 }, computer: { running: true, url: "https://www.resy.com/x" }, settings: { summary: "Friendly · short" } },
      false,
    );
    expect(t).toEqual({ routines: "3 on · next 8:00", checkins: "Next 9:30 pm", about: "2 new today", computer: "Live", settings: "Friendly · short" });
    const g = tileLines(
      { routines: { on: 1, next: "Fri 2 pm" }, checkins: {}, about: { count: 12, newToday: 0 }, computer: { running: true, url: "https://resy.com" }, settings: { summary: "" } },
      true,
    );
    expect(g).toEqual({ routines: "1 on · Fri 2 pm", checkins: "None set", about: "12 things", computer: "On resy.com · live", settings: "Answers when named" });
    // The gateway sends the instants; the page words them in the viewer's time.
    const now = new Date(2026, 10, 2, 18, 10);
    const read = readOverview({ tiles: { routines: { on: 2, next: new Date(2026, 10, 2, 20, 0).getTime() }, checkins: { next: new Date(2026, 10, 2, 21, 30).getTime(), count: 2 } } });
    const n = tileLines(read!.tiles, false, now);
    expect(n.routines).toBe("2 on · next 8:00");
    expect(n.checkins).toBe("Next 9:30");
  });

  test("a check-in's time is edited in the form the gateway takes", () => {
    const at = new Date(2026, 10, 3, 9, 5).getTime();
    expect(whenField(at)).toBe("2026-11-03 09:05");
    expect(isWhenField(whenField(at))).toBe(true);
    expect(isWhenField("Tonight at 9:30")).toBe(false);
    const page = readList("checkins", { items: [{ id: "c1", when: "Tonight at 9:30", what: "x", at }] });
    expect(page.items[0]!.at).toBe(at);
  });

  test("a turn's actions link only what they name", () => {
    expect(actionPieces({ kind: "advisor", label: "Asked the Advisor", ref: "a1" })).toEqual({ before: "Asked the ", link: "Advisor", after: "" });
    expect(actionPieces({ kind: "job", label: "Started Minion 2", ref: "j" })).toEqual({ before: "Started ", link: "Minion 2", after: "" });
    expect(actionPieces({ kind: "job", label: "Started Minion 2" })).toEqual({ before: "Started Minion 2", after: "" });
    expect(actionPieces({ kind: "mailcheck", label: "Email check passed it" })).toEqual({ before: "", link: "Email check", after: " passed it" });
    expect(turnTail({ at: 0, who: "Cy", said: "", thought: "", did: [], reply: null, ms: 500 })).toEqual(["Stayed quiet", "0.5 s"]);
    expect(seconds(3800)).toBe("3.8 s");
  });

  test("the clock reads as the mock's", () => {
    const now = new Date(2026, 10, 1, 18, 10);
    expect(clock(new Date(2026, 10, 1, 18, 5).getTime(), now)).toBe("6:05");
    expect(clock(new Date(2026, 10, 1, 9, 20).getTime(), now)).toBe("9:20 am");
  });
});

describe("the job page's look at Tex's browser", () => {
  test("shows only on the job that is on that site", () => {
    const job = { title: "Book dinner", steps: [{ at: 0, text: "Opened resy.com to book" }] };
    expect(onSite(job, "https://www.resy.com/x")).toBe(true);
    expect(onSite(job, "https://maritime.sh/docs")).toBe(false);
    expect(onSite(job, "not a url")).toBe(false);
  });
});

describe("the address", () => {
  test("a place round-trips, and anything else reads as the first screen", () => {
    expect(readPlace({})).toEqual({ chat: "me" });
    expect(readPlace({ chat: "g1", view: "routines" })).toEqual({ chat: "g1", view: "routines" });
    expect(readPlace({ chat: "../x", view: "nope", job: "<script>" })).toEqual({ chat: "me" });
    expect(readPlace({ view: "computer", full: "1" })).toEqual({ chat: "me", view: "computer", full: true });
  });

  // The owner, 2026-11-03: Tex's links go to `/tex/@user` and `/tex/group/<words>`, and to sub-pages under them.
  const KEY = "a".repeat(64);
  const CHATS = [
    { key: "me", name: "Just you" },
    { key: KEY, name: "Band", people: 3, home: { context: "@context-lc", folder: "tex/groups/brave-otter-lamp" } },
    { key: "b".repeat(64), name: "Old chat", people: 2 },
  ];

  test("a sub-page or a job is a path under the chat, and the old query still reads", () => {
    expect(readPlace({ handle: "@seyi", rest: ["routines"] })).toEqual({ chat: "me", view: "routines" });
    expect(readPlace({ handle: "@seyi", rest: ["job", "j_123"] })).toEqual({ chat: "me", job: "j_123" });
    expect(readPlace({ handle: "@seyi", rest: ["computer"], full: "1" })).toEqual({ chat: "me", view: "computer", full: true });
    // A path wins over the query, and anything it doesn't know is the first screen.
    expect(readPlace({ rest: ["jobs"], view: "routines" })).toEqual({ chat: "me", view: "jobs" });
    for (const rest of [["nope"], ["job"], ["job", "<script>"], ["job", "j1", "x"], ["routines", "x"]]) expect(readPlace({ rest })).toEqual({ chat: "me" });
    expect(readPlace({ view: "computer" })).toEqual({ chat: "me", view: "computer" });
  });

  test("the address for a place: the person's own under their handle, a group under its words", () => {
    expect(placeHref("seyi", { chat: "me" }, CHATS)).toBe("/tex/@seyi");
    expect(placeHref("seyi", { chat: "me", view: "jobs" }, CHATS)).toBe("/tex/@seyi/jobs");
    expect(placeHref("seyi", { chat: KEY }, CHATS)).toBe("/tex/group/brave-otter-lamp");
    expect(placeHref("seyi", { chat: KEY, job: "j1" }, CHATS)).toBe("/tex/group/brave-otter-lamp/job/j1");
    expect(placeHref("seyi", { chat: KEY, view: "computer", full: true }, CHATS)).toBe("/tex/group/brave-otter-lamp/computer?full=1");
    // A group with no home keeps the old query under the person's own address.
    expect(placeHref("seyi", { chat: "b".repeat(64), view: "routines" }, CHATS)).toBe(`/tex/@seyi/routines?chat=${"b".repeat(64)}`);
    expect(addressOf("/tex/@seyi", { job: "a b" })).toBe("/tex/@seyi/job/a%20b");
  });

  test("a group's words find only that group among the person's own chats", () => {
    expect(chatOfWords(CHATS, "brave-otter-lamp")).toBe(KEY);
    expect(chatOfWords(CHATS, "calm-river-stone")).toBeNull();
    expect(chatOfWords([{ key: "me", name: "Just you", home: { context: "@x", folder: "tex/groups/brave-otter-lamp" } }], "brave-otter-lamp")).toBeNull();
  });
});

function fakeSockets() {
  const made: (SocketLike & { url: string; protocols: string[]; sent: string[]; closed?: boolean })[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  return {
    made,
    timers,
    open: (url: string, protocols: string[]) => {
      const s = { url, protocols, sent: [] as string[], readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as SocketLike & {
        url: string;
        protocols: string[];
        sent: string[];
        closed?: boolean;
      };
      s.send = (d: string) => void s.sent.push(d);
      s.close = () => {
        s.closed = true;
      };
      made.push(s);
      return s;
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the live socket", () => {
  test("the grant rides as a subprotocol, never in the address", () => {
    expect(liveSocketUrl("https://mcp.example.test")).toBe("wss://mcp.example.test/tex/page/live");
    // The gateway decides whose page and which chat at the upgrade, from the query: without them every socket is refused.
    expect(liveSocketUrl("https://mcp.example.test", "ada", "g1")).toBe("wss://mcp.example.test/tex/page/live?handle=ada&chat=g1");
    expect(liveProtocols("K")).toEqual(["context.tex-page", "context.ticket.K"]);
  });

  test("only patches are read", () => {
    expect(readPatch(JSON.stringify({ t: "patch", section: "routines" }))).toEqual({ section: "routines" });
    expect(readPatch(JSON.stringify({ t: "patch", section: "status", value: { jobs: 1 } }))).toEqual({ section: "status", value: { jobs: 1 } });
    expect(readPatch(JSON.stringify({ t: "pong" }))).toBeNull();
    expect(readPatch("{nope")).toBeNull();
    expect(readPatch(null)).toBeNull();
  });

  test("it says which chat, hands on patches, and a reconnect says the chat again", async () => {
    const f = fakeSockets();
    const patches: unknown[] = [];
    const ups: boolean[] = [];
    const live = openLive({
      gatewayOrigin: "https://mcp.example.test",
      handle: "ada",
      chat: "me",
      token: async () => "tok",
      ticket: async (token) => `ticket-${token}`,
      onPatch: (p) => patches.push(p),
      onLive: (u) => ups.push(u),
      open: f.open,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
    await flush();
    const first = f.made[0]!;
    expect(first.url).not.toContain("tok");
    expect(first.url).toBe("wss://mcp.example.test/tex/page/live?handle=ada&chat=me");
    first.readyState = 1;
    first.onopen!({});
    expect(JSON.parse(first.sent[0]!)).toEqual({ t: "watch", handle: "ada", chat: "me" });
    first.onmessage!({ data: JSON.stringify({ t: "patch", section: "about" }) });
    expect(patches).toEqual([{ section: "about" }]);
    // Another chat is another chat's object: a new socket, opened on that chat.
    live.watch("g1");
    expect(first.closed).toBe(true);
    await flush();
    const second = f.made[1]!;
    expect(second.url).toBe("wss://mcp.example.test/tex/page/live?handle=ada&chat=g1");
    // The old socket's close, arriving late, neither reconnects nor speaks for the new one.
    const timersBefore = f.timers.length;
    first.onclose!({ code: 1000 });
    first.onmessage!({ data: JSON.stringify({ t: "patch", section: "stale" }) });
    expect(f.timers.length).toBe(timersBefore);
    expect(patches).toEqual([{ section: "about" }]);
    second.readyState = 1;
    second.onopen!({});
    expect(JSON.parse(second.sent[0]!)).toEqual({ t: "watch", handle: "ada", chat: "g1" });
    // Closed to be authorized again: back at once, on the chat it follows now.
    second.onclose!({ code: 4001 });
    const again = f.timers.at(-1)!;
    expect(again.ms).toBe(0);
    again.fn();
    await flush();
    const third = f.made[2]!;
    expect(third.url).toContain("chat=g1");
    third.readyState = 1;
    third.onopen!({});
    expect(JSON.parse(third.sent[0]!)).toEqual({ t: "watch", handle: "ada", chat: "g1" });
    expect(ups).toEqual([true, false, true, false, true]);
    live.close();
  });

  test("a refused socket waits minutes, not seconds", async () => {
    const f = fakeSockets();
    openLive({
      gatewayOrigin: "https://mcp.example.test",
      handle: "ada",
      chat: "g-not-mine",
      token: async () => "tok",
      ticket: async (token) => `ticket-${token}`,
      onPatch: () => {},
      onLive: () => {},
      open: f.open,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
    await flush();
    f.made[0]!.onclose!({ code: 4403 });
    expect(f.timers.at(-1)!.ms).toBe(5 * 60_000);
  });
});

// A runner's pairing link opened signed out: the code must survive signing in,
// or the person lands on the machines list with nothing to approve.
test("signing in keeps a pairing link's code", () => {
  const next = decodeURIComponent(signInHref("/login", { handle: "seyi" }, { chat: "me", view: "machines" }, "NQJ-FSV"));
  expect(next).toContain("/tex/@seyi/machines?code=NQJ-FSV");
  expect(decodeURIComponent(signInHref("/login", { handle: "seyi" }, { chat: "me", view: "machines" }))).not.toContain("code=");
  expect(decodeURIComponent(signInHref("/login", { handle: null, words: "brave-otter-lamp" }, { chat: "me", view: "routines" }))).toContain("/tex/group/brave-otter-lamp/routines");
});

// The machines list's Review opens the connect screen as a new screen: the code
// must ride in its address, or the screen shows "Waiting for a code".
test("Review carries a pairing link's code to the connect screen", () => {
  const KEY = "a".repeat(64);
  const CHATS = [{ key: KEY, name: "Band", people: 3, home: { context: "@context-lc", folder: "tex/groups/brave-otter-lamp" } }];
  expect(placeHref("seyi", { chat: "me", view: "connect" }, CHATS, "L7E-JQ3")).toBe("/tex/@seyi/connect?code=L7E-JQ3");
  expect(placeHref("seyi", { chat: "me", view: "connect" }, CHATS)).toBe("/tex/@seyi/connect");
  expect(placeHref("seyi", { chat: "me", view: "machines" }, CHATS, "L7E-JQ3")).toBe("/tex/@seyi/machines");
  expect(placeHref("seyi", { chat: KEY, view: "connect" }, CHATS, "L7E-JQ3")).toBe("/tex/group/brave-otter-lamp/connect?code=L7E-JQ3");
});

describe("a turn's sent-back drafts", () => {
  test("are read with what sent each back, and a turn with none has none", () => {
    const page = readList("thinking", {
      items: [
        { at: 1, reply: "Red Sorghum.", drafts: [{ text: "try Lugo's", by: "gates", failed: ["heard_them", 3], notice: "Answer what they asked." }, { text: "a list", by: "code" }, { by: "late" }] },
        { at: 2, reply: "Done." },
      ],
    });
    expect(page.items[0].drafts).toEqual([
      { text: "try Lugo's", by: "gates", failed: ["heard_them"], notice: "Answer what they asked." },
      { text: "a list", by: "code", failed: [] },
    ]);
    expect(page.items[1].drafts).toBeUndefined();
    expect(draftReason({ by: "gates", failed: ["heard_them", "short_and_clean"] })).toBe("Sent back by heard them, short and clean");
    expect(draftReason({ by: "code", failed: [] })).toBe("Sent back by a check");
    expect(draftReason({ by: "late", failed: [] })).toBe("Redone for a text that came in");
    expect(draftReason({ by: "review", failed: ["claims_undone"] })).toBe("Sent back by the reviewer: claims undone");
    expect(draftReason({ by: "review", failed: [] })).toBe("Sent back by the reviewer");
  });
});
