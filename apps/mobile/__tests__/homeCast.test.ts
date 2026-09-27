import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { splitWebsiteCast, type CastActor } from "@context/shared";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import { cursorOffset } from "../features/console/presence/sync";
import type { PresenceMember } from "../features/console/presence/protocol";
import { agentName, handleInitials } from "../features/console/presence/agentName";
import { CAST_ORIGIN, LIVELY, castColors, playCast, type CastHost } from "../features/home/cast/castRun";
import { castPresence, castSite } from "../features/home/cast/castSite";
import { pageNamed, recordAgent } from "../features/home/cast/useHomeCast";
import { presenceChipLabel } from "../features/console/ConsoleShell";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const PAGE = "# wth is this\n\nlike obsidian and notion had a baby\n\n```cast\nCAST\n```\n\n[create a workspace](/workspace/new)\n";

function stage(script: string, over: Partial<CastHost> = {}) {
  const { markdown, steps } = splitWebsiteCast(PAGE.replace("CAST", script));
  const shared = createSharedDoc({});
  seedSharedDoc(shared, markdown);
  const rooms: PresenceMember[][] = [];
  const did: Array<[string, string, string]> = [];
  const host: CastHost = {
    schedule: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    instant: () => false,
    pageNamed: (name) => (name === "pricing" ? "03-Pricing.md" : null),
    addNote: (name) => `${name}.md`,
    agentDid: (actor: CastActor, kind, path) => did.push([actor.name, kind, path]),
    room: (members) => rooms.push(members),
    ...over,
  };
  const run = playCast(steps, shared, host, { path: "01-Home.md" });
  const last = () => rooms[rooms.length - 1] ?? [];
  return { shared, run, rooms, did, last, text: () => shared.text.toString() };
}

describe("playCast", () => {
  test("waits before the first step, so the page is read before anything moves", () => {
    const show = stage("Claude writes: hello there.");
    jest.advanceTimersByTime(LIVELY.startMs - 1);
    expect(show.text()).not.toContain("hello there.");
    jest.advanceTimersByTime(1);
    expect(show.text()).toContain("hello there.");
  });

  test("an agent's line lands whole, as its own paragraph, where the block was, highlighted", () => {
    const show = stage("Claude writes: new here? read the tour.");
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.text()).toBe(
      "# wth is this\n\nlike obsidian and notion had a baby\n\nnew here? read the tour.\n\n[create a workspace](/workspace/new)\n",
    );
    const [claude] = show.last();
    expect(claude).toMatchObject({ name: "Claude", isAgent: true, color: "#f59e0b" });
    const from = cursorOffset(claude!.anchor!, show.shared.doc)!;
    const to = cursorOffset(claude!.head!, show.shared.doc)!;
    expect(show.text().slice(from, to)).toBe("new here? read the tour.");
    expect(show.did).toEqual([["Claude", "write", "01-Home.md"]]);
    // The highlight settles into a caret at the end of what it wrote.
    jest.advanceTimersByTime(LIVELY.highlightMs);
    expect(show.last()[0]!.anchor).toBe(show.last()[0]!.head);
  });

  test("a person types it letter by letter, with a caret that moves every keystroke", () => {
    const show = stage("@maya adds to the line above: (the baby can read.)");
    jest.advanceTimersByTime(LIVELY.startMs + LIVELY.keyMs * 3);
    expect(show.text()).toContain("had a baby (\n");
    expect(show.last()[0]).toMatchObject({ name: "@maya", isAgent: false });
    const heads = new Set<string | null>();
    for (let i = 0; i < 40; i += 1) {
      jest.advanceTimersByTime(LIVELY.keyMs * 5);
      heads.add(show.last()[0]?.head ?? null);
    }
    expect(show.text()).toContain("like obsidian and notion had a baby (the baby can read.)\n\n[create");
    expect(heads.size).toBeGreaterThan(5);
  });

  test("with reduced motion a person's words land whole", () => {
    const show = stage("@maya types: p.s. this page is live.", { instant: () => true });
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.text()).toContain("had a baby\n\np.s. this page is live.\n\n[create");
  });

  test("the visitor typing ends the show at once, and everybody leaves the note", () => {
    const show = stage("Claude reads\n@maya types: this will never be typed");
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.last()).toHaveLength(1);
    show.shared.doc.transact(() => show.shared.text.insert(0, "x"), "the visitor's editor");
    expect(show.last()).toEqual([]);
    jest.advanceTimersByTime(60_000);
    expect(show.text()).not.toContain("never");
  });

  test("the cast's own writes do not stop it", () => {
    const show = stage("Claude writes: one\nClaude writes: two");
    jest.advanceTimersByTime(LIVELY.startMs + LIVELY.gapMs);
    expect(show.text()).toContain("one");
    expect(show.text()).toContain("two");
    expect(CAST_ORIGIN.description).toBe("cast");
  });

  test("reading this note joins it with no caret; reading another page marks that page", () => {
    const show = stage("ChatGPT reads\nClaude reads: pricing");
    jest.advanceTimersByTime(LIVELY.startMs + LIVELY.gapMs);
    expect(show.last()).toEqual([
      expect.objectContaining({ name: "ChatGPT", anchor: null, head: null, isAgent: true, color: "#10b981" }),
    ]);
    expect(show.did).toEqual([
      ["ChatGPT", "read", "01-Home.md"],
      ["Claude", "read", "03-Pricing.md"],
    ]);
  });

  test("a new note is added beside the page and marked as the agent's write", () => {
    const added: Array<[string, string]> = [];
    const show = stage("Claude adds note: getting-started\n  # Getting started", {
      addNote: (name, text) => {
        added.push([name, text]);
        return "getting-started.md";
      },
    });
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(added).toEqual([["getting-started", "# Getting started"]]);
    expect(show.did).toEqual([["Claude", "write", "getting-started.md"]]);
  });

  test("after the last step everybody leaves, one at a time", () => {
    const show = stage("Claude reads\n@maya types: hi");
    jest.advanceTimersByTime(30_000);
    expect(show.last()).toEqual([]);
    const sizes = show.rooms.map((room) => room.length);
    expect(Math.max(...sizes)).toBe(2);
    expect(sizes).toContain(1);
  });

  test("stop ends it for good", () => {
    const show = stage("Claude writes: never");
    show.run.stop();
    jest.advanceTimersByTime(60_000);
    expect(show.text()).not.toContain("never");
  });
});

describe("castSite", () => {
  test("takes the blocks out of each page and keeps each page's steps", () => {
    const site = castSite([
      { routePath: "/", title: "Home", markdown: PAGE.replace("CAST", "Claude reads") },
      { routePath: "/pricing", title: "Pricing", markdown: "# Pricing\n" },
    ]);
    expect(site.pages[0]!.markdown).not.toContain("cast");
    expect(site.pages[1]!.markdown).toBe("# Pricing\n");
    expect([...site.scripts.keys()]).toEqual(["/"]);
    expect(site.colors.get("Claude")).toBe("#f59e0b");
  });

  test("the cast's room says it is a demo in the chip", () => {
    const shared = createSharedDoc({});
    const member = { id: "cast:@maya", name: "@maya", color: "#ec4899", anchor: null, head: null, canWrite: false, isAgent: false };
    const presence = castPresence(shared, [member]);
    expect(presence).toMatchObject({ phase: "live", settled: true, canWrite: true, summary: "1 here" });
    expect(presenceChipLabel(presence)).toBe("@maya · 1 other here · demo");
    expect(castPresence(shared, []).summary).toBe("");
  });
});

describe("the agents line", () => {
  test("counts each agent's reads and writes, newest first, one mark per note", () => {
    const claude = { name: "Claude", kind: "agent" as const };
    const colors = new Map([["Claude", "#f59e0b"]]);
    let view = recordAgent({ agents: [], marks: [] }, claude, "read", "a.md", colors, 1);
    view = recordAgent(view, claude, "write", "a.md", colors, 2);
    expect(view.agents).toEqual([
      { id: "a:cast-Claude", name: "Claude", color: "#f59e0b", at: 2, kind: "write", path: "a.md", reads: 1, writes: 1 },
    ]);
    expect(view.marks).toEqual([{ path: "a.md", kind: "write", at: 2, agent: "a:cast-Claude" }]);
  });

  test("a step names a page by title, address or file name", () => {
    const pages = new Map([["03-Pricing.md", { routePath: "/pricing", title: "Pricing", markdown: "" }]]);
    expect(pageNamed("pricing", pages, {})).toBe("03-Pricing.md");
    expect(pageNamed("/pricing", pages, {})).toBe("03-Pricing.md");
    expect(pageNamed("getting-started", pages, { "getting-started.md": "" })).toBe("getting-started.md");
    expect(pageNamed("nowhere", pages, {})).toBeNull();
  });
});

describe("whose agent it is", () => {
  test("an agent's name splits into its owner and itself; a person's never does", () => {
    expect(agentName("@jon's Claude")).toEqual({ owner: "@jon", agent: "Claude" });
    expect(agentName("@maya\u2019s Codex")).toEqual({ owner: "@maya", agent: "Codex" });
    expect(agentName("@maya")).toEqual({ owner: null, agent: "@maya" });
    expect(agentName("Claude")).toEqual({ owner: null, agent: "Claude" });
    expect(handleInitials("@jon")).toBe("jo");
  });

  test("two people's Claudes are two colours, and the first keeps Claude's", () => {
    const { steps } = splitWebsiteCast("```cast\n@jon's Claude reads\n@maya's Claude reads\n@maya types: hi\n```\n");
    const colors = castColors(steps);
    expect(colors.get("@jon's Claude")).toBe("#f59e0b");
    expect(colors.get("@maya's Claude")).not.toBe("#f59e0b");
    expect(new Set(colors.values()).size).toBe(3);
  });
});
