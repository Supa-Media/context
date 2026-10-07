/**
 * THE LIVE MAP'S DATA: the gateway's and the control plane's answers turned
 * into what the engine draws, the poll that keeps them coming, and what the
 * console says about its own person on it. Fake names and paths only.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { decodeAgentActivity } from "../features/console/agents/agentActivity";
import { announceDid, announceOpenNote, resetAnnouncements, takeAnnouncement } from "../features/console/map/live/announce";
import {
  actorsFromActivity,
  applyEvents,
  eventsFromActivity,
  eventsFromCrossMoves,
  eventsFromHistory,
  graphFromAnswer,
  mergeEvents,
} from "../features/console/map/live/convert";
import { createActivityPoller, type PollerDeps } from "../features/console/map/live/livePoller";

afterEach(() => resetAnnouncements());

const ANSWER = {
  agents: [
    {
      id: "a:claude",
      name: "Seyi's Claude",
      kind: "read",
      doing: "read",
      path: "1-projects/pricing.md",
      at: 500,
      reads: 2,
      writes: 0,
      readPaths: ["1-projects/launch.md", "1-projects/pricing.md"],
    },
    { id: "a:sorter", name: "Inbox sorter", kind: "write", doing: "move", from: "0-inbox/r.md", path: "2-areas/r.md", at: 400 },
    // An older gateway: no `doing`, so a write is an edit.
    { id: "a:old", name: "Codex", kind: "write", path: "index.md", at: 300 },
  ],
  people: [
    { id: "p:maya", name: "Maya", path: "1-projects/pricing.md", doing: "edit" },
    { id: "p:me", name: "Seyi", self: true, path: null },
  ],
  peopleCount: 2,
  events: [
    { at: 100, kind: "read", path: "1-projects/launch.md", actor: { id: "a:claude", kind: "agent", name: "Seyi's Claude" } },
    { at: 200, kind: "move", path: "2-areas/r.md", from: "0-inbox/r.md", actor: { id: "a:sorter", kind: "agent", name: "Inbox sorter" } },
    { at: 250, kind: "create", path: "1-projects/new.md", actor: { id: "p:maya", kind: "person", name: "Maya" } },
  ],
};

describe("the activity answer as map actors and events", () => {
  const view = decodeAgentActivity(ANSWER);

  test("agents keep their finer kind and what they read, in order; people sit on their note", () => {
    const actors = actorsFromActivity(view, "ws-a", 999);
    const byId = Object.fromEntries(actors.map((a) => [a.id, a]));
    expect(byId["a:claude"]).toMatchObject({ kind: "agent", doing: "read", path: "1-projects/pricing.md", reads: ["1-projects/launch.md", "1-projects/pricing.md"], workspaceId: "ws-a" });
    expect(byId["a:sorter"]).toMatchObject({ doing: "move", path: "2-areas/r.md" });
    expect(byId["a:old"]).toMatchObject({ doing: "edit" });
    expect(byId["p:maya"]).toMatchObject({ kind: "person", doing: "edit", path: "1-projects/pricing.md", at: 999 });
    expect(byId["p:me"]).toMatchObject({ self: true, doing: "idle", path: null });
  });

  test("events keep their actor, and a move its two ends", () => {
    expect(eventsFromActivity(view, "ws-a")).toEqual([
      { kind: "read", at: 100, workspaceId: "ws-a", path: "1-projects/launch.md", actor: { id: "a:claude", kind: "agent", name: "Seyi's Claude" } },
      { kind: "move", at: 200, workspaceId: "ws-a", from: "0-inbox/r.md", to: "2-areas/r.md", actor: { id: "a:sorter", kind: "agent", name: "Inbox sorter" } },
      { kind: "create", at: 250, workspaceId: "ws-a", path: "1-projects/new.md", actor: { id: "p:maya", kind: "person", name: "Maya" } },
    ]);
  });
});

describe("a graph answer", () => {
  test("keeps only edges that join two of its own nodes, once", () => {
    const g = graphFromAnswer(
      { nodes: [{ path: "a.md", title: "A" }, { path: "b.md", title: "B" }], edges: [[0, 1], [1, 0], [0, 0], [0, 7], [-1, 1]], truncated: false },
      { id: "ws-a", slug: "maya", name: "Personal", kind: "personal" },
    );
    expect(g).toEqual({ workspaceId: "ws-a", slug: "maya", name: "Personal", kind: "personal", nodes: [{ path: "a.md", title: "A" }, { path: "b.md", title: "B" }], edges: [[0, 1]] });
  });

  test("is named by the workspace's display name, and by its address only when it has none", () => {
    const answer = { nodes: [], edges: [], truncated: false };
    expect(graphFromAnswer(answer, { id: "ws-a", slug: "maya", name: "Personal", kind: "personal" }).name).toBe("Personal");
    expect(graphFromAnswer(answer, { id: "ws-a", slug: "maya", name: "  ", kind: "personal" }).name).toBe("maya");
  });
});

describe("history for a replay", () => {
  test("added, revised and moved lines become events; a move without its pairs is left out", () => {
    const events = eventsFromHistory(
      [
        { at: "2026-10-07T10:00:00.000Z", kind: "added", paths: ["0-inbox/a.md"], by: "@maya", via: null },
        { at: "2026-10-07T10:05:00.000Z", kind: "revised", paths: ["1-projects/p.md"], by: "@seyi", via: "Claude" },
        { at: "2026-10-07T10:10:00.000Z", kind: "moved", paths: ["2-areas/a.md"], by: "@seyi", via: "Claude", moves: [["0-inbox/a.md", "2-areas/a.md"]] },
        { at: "2026-10-07T10:11:00.000Z", kind: "moved", paths: ["2-areas/b.md"], by: "@seyi", via: null },
        { at: "2026-10-07T10:12:00.000Z", kind: "published", paths: ["2-areas/b.md"], by: "@seyi", via: null },
      ],
      "ws-a",
    );
    expect(events.map((e) => `${e.kind} ${e.actor.kind} ${e.actor.name} ${e.kind === "move" ? `${e.from}>${e.to}` : e.path}`)).toEqual([
      "create person @maya 0-inbox/a.md",
      "edit agent @seyi's Claude 1-projects/p.md",
      "move agent @seyi's Claude 0-inbox/a.md>2-areas/a.md",
    ]);
  });

  test("a move between workspaces names both", () => {
    const [e] = eventsFromCrossMoves([
      { at: 5, fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b", fromPath: "0-inbox/a.md", toPath: "1-projects/a.md", actorName: "@seyi", via: "console" },
    ]);
    expect(e).toEqual({ kind: "move", at: 5, workspaceId: "ws-a", from: "0-inbox/a.md", to: "1-projects/a.md", toWorkspaceId: "ws-b", actor: { id: "h:@seyi", kind: "person", name: "@seyi" } });
  });

  test("a folder moved between workspaces is not drawn as one note flying", () => {
    expect(
      eventsFromCrossMoves([
        { at: 5, fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b", fromPath: "1-projects/old", toPath: "4-archive/old", actorName: null, via: "agent" },
      ]),
    ).toEqual([]);
  });

  test("the same event from two sources is kept once", () => {
    const a = eventsFromHistory([{ at: "2026-10-07T10:00:00.000Z", kind: "added", paths: ["a.md"], by: "@m", via: null }], "w");
    expect(mergeEvents(a, a)).toHaveLength(1);
  });
});

describe("the graphs catch up with live events between reads", () => {
  const who = { id: "a:s", kind: "agent" as const, name: "Inbox sorter" };
  const a = () =>
    graphFromAnswer(
      { nodes: [{ path: "0-inbox/r.md", title: "Receipt" }, { path: "2-areas/f.md", title: "Finance" }, { path: "1-projects/p.md", title: "P" }], edges: [[0, 1], [1, 2]] },
      { id: "ws-a", slug: "a", name: "Personal", kind: "personal" },
    );
  const b = () => graphFromAnswer({ nodes: [], edges: [] }, { id: "ws-b", slug: "b", name: "Supa", kind: "shared" });

  test("a move the graph does not show yet is applied, keeping the note's name and links", () => {
    const [g] = applyEvents([a()], [{ kind: "move", at: 1, workspaceId: "ws-a", from: "0-inbox/r.md", to: "2-areas/r.md", actor: who }]);
    expect(g!.nodes[0]).toEqual({ path: "2-areas/r.md", title: "Receipt" });
    expect(g!.edges).toEqual([[0, 1], [1, 2]]);
  });

  test("an event the graph already shows changes nothing, so it is safe to run twice", () => {
    const once = applyEvents([a()], [{ kind: "move", at: 1, workspaceId: "ws-a", from: "0-inbox/r.md", to: "2-areas/r.md", actor: who }]);
    const twice = applyEvents(once, [{ kind: "move", at: 1, workspaceId: "ws-a", from: "0-inbox/r.md", to: "2-areas/r.md", actor: who }]);
    expect(twice).toEqual(once);
    const created = applyEvents([a()], [{ kind: "create", at: 1, workspaceId: "ws-a", path: "0-inbox/r.md", actor: who }]);
    expect(created[0]!.nodes).toHaveLength(3);
  });

  test("a new note appears; a note moved to another workspace leaves one graph for the other with its links dropped", () => {
    const [g1, g2] = applyEvents(
      [a(), b()],
      [
        { kind: "create", at: 1, workspaceId: "ws-a", path: "0-inbox/new.md", actor: who },
        { kind: "move", at: 2, workspaceId: "ws-a", from: "2-areas/f.md", to: "1-projects/f.md", toWorkspaceId: "ws-b", actor: who },
      ],
    );
    expect(g1!.nodes.map((n) => n.path)).toEqual(["0-inbox/r.md", "1-projects/p.md", "0-inbox/new.md"]);
    expect(g1!.edges).toEqual([]);
    expect(g2!.nodes).toEqual([{ path: "1-projects/f.md", title: "Finance" }]);
  });
});

/** A poller with a fake clock, timer queue, mint and fetch. */
function harness(options: { hidden?: () => boolean; answers?: unknown[] } = {}) {
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  const answers = [...(options.answers ?? [ANSWER])];
  const seen: unknown[] = [];
  let mints = 0;
  const deps: PollerDeps = {
    origin: "https://gateway.example",
    mint: async () => {
      mints += 1;
      return { accessToken: "token", expiresAt: 10 * 60_000 };
    },
    fetchJson: async (url) => {
      urls.push(url);
      return answers.length > 0 ? answers.shift()! : { agents: [], marks: [] };
    },
    hidden: options.hidden ?? (() => false),
    now: () => 0,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    onAnswer: (_ws, view) => seen.push(view),
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const tick = async () => {
    const fn = timers.shift();
    fn?.();
    await flush();
    await flush();
  };
  return { deps, urls, timers, seen, tick, flush, mints: () => mints };
}

describe("the map's poll", () => {
  test("asks again with `since` set to the newest event it holds", async () => {
    const h = harness();
    const poller = createActivityPoller("ws-a", h.deps);
    poller.start();
    await h.flush();
    await h.flush();
    expect(h.urls[0]).toBe("https://gateway.example/agent-activity");
    expect(poller.since()).toBe(250);
    await h.tick();
    expect(h.urls[1]).toBe("https://gateway.example/agent-activity?since=250");
    expect(h.mints()).toBe(1);
    poller.stop();
  });

  test("asks nothing while the tab is hidden, and asks at once when poked back", async () => {
    let hidden = true;
    const h = harness({ hidden: () => hidden });
    const poller = createActivityPoller("ws-a", h.deps);
    poller.start();
    await h.flush();
    await h.tick();
    await h.tick();
    expect(h.urls).toEqual([]);
    expect(h.timers.length).toBe(1);
    hidden = false;
    poller.poke();
    await h.flush();
    await h.flush();
    expect(h.urls).toHaveLength(1);
    poller.stop();
  });

  test("a stopped poller schedules nothing more", async () => {
    const h = harness();
    const poller = createActivityPoller("ws-a", h.deps);
    poller.start();
    poller.stop();
    await h.flush();
    await h.flush();
    expect(h.seen).toEqual([]);
  });
});

describe("what the console says about its own person", () => {
  test("the open note and doing ride the next poll of that workspace only", () => {
    announceOpenNote("ws-a", "1-projects/p.md", "edit");
    expect(takeAnnouncement("ws-a", 7).query).toBe("?since=7&note=1-projects%2Fp.md&doing=edit");
    expect(takeAnnouncement("ws-b").query).toBe("");
    // Opening a note in another workspace closes the first.
    announceOpenNote("ws-b", "a.md");
    expect(takeAnnouncement("ws-a").query).toBe("");
    announceOpenNote("ws-b", null);
    expect(takeAnnouncement("ws-b").query).toBe("");
  });

  test("a finished create or move is said once, one per request, and put back when the request fails", () => {
    announceDid("ws-a", { kind: "create", path: "0-inbox/new.md" });
    announceDid("ws-a", { kind: "move", from: "0-inbox/new.md", to: "1-projects/new.md" });
    announceDid("ws-a", { kind: "move", from: "folder", to: "other/folder" });
    const first = takeAnnouncement("ws-a");
    expect(first.query).toBe("?did=create&path=0-inbox%2Fnew.md");
    first.restore();
    expect(takeAnnouncement("ws-a").query).toBe("?did=create&path=0-inbox%2Fnew.md");
    expect(takeAnnouncement("ws-a").query).toBe("?did=move&from=0-inbox%2Fnew.md&to=1-projects%2Fnew.md");
    expect(takeAnnouncement("ws-a").query).toBe("");
  });

  test("a failed poll puts its announcement back for the next one", async () => {
    announceDid("ws-a", { kind: "create", path: "a.md" });
    const h = harness();
    h.deps.fetchJson = async (url) => {
      h.urls.push(url);
      return null;
    };
    const poller = createActivityPoller("ws-a", h.deps);
    poller.start();
    await h.flush();
    await h.flush();
    poller.stop();
    expect(h.urls[0]).toContain("did=create");
    expect(takeAnnouncement("ws-a").query).toBe("?did=create&path=a.md");
  });
});
