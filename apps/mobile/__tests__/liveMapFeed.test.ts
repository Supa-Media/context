/**
 * THE WORDS BESIDE THE LIVE MAP.
 *
 * Every line is plain language with the note in bold: who, what, which note,
 * and for a move where it went, in the words a person uses for a folder —
 * "to Areas", and across workspaces "to Supa › Projects". Fake names only.
 */
import { describe, expect, test } from "@jest/globals";
import {
  crossMoveRows,
  eventParts,
  liveFeed,
  nameBook,
  replayFeed,
  sentence,
  whenText,
  workingNowLine,
  type FeedItem,
} from "../features/console/map/live/feed";
import { clockText } from "../features/console/map/live/replayClock";
import type { MapActor } from "../features/console/map/live/engine/timeline";
import { WHO, ev, graph } from "./liveMapFixture";

const personal = graph("ws-p", "Personal", ["0-inbox/receipt-from-figma.md", "1-projects/pricing.md", "2-areas/finance.md", "index.md"]);
const supa = graph("ws-s", "Supa", ["1-projects/call-with-dana.md", "1-projects/launch-plan.md"], "shared");
personal.nodes[0]!.title = "Receipt from Figma";
personal.nodes[1]!.title = "Pricing";
supa.nodes[0]!.title = "Call with Dana";
const book = nameBook([personal, supa]);
const line = (item: Pick<FeedItem, "actor" | "parts">) => sentence(item);

describe("one event, in words", () => {
  test("every kind, happening and done, with the note in bold", () => {
    const cases: Array<[ReturnType<typeof ev.read>, boolean, string]> = [
      [ev.read(1, "ws-p", "1-projects/pricing.md", WHO.maya), true, "Maya is reading Pricing"],
      [ev.read(1, "ws-p", "1-projects/pricing.md", WHO.maya), false, "Maya read Pricing"],
      [ev.edit(1, "ws-p", "1-projects/pricing.md", WHO.jon), true, "Jon is editing Pricing"],
      [ev.edit(1, "ws-p", "1-projects/pricing.md", WHO.jon), false, "Jon edited Pricing"],
      [ev.create(1, "ws-p", "1-projects/launch-recap.md"), true, "Seyi's Claude is writing a new note, launch-recap"],
      [ev.create(1, "ws-p", "1-projects/launch-recap.md"), false, "Seyi's Claude wrote a new note, launch-recap"],
    ];
    for (const [e, now, words] of cases) {
      const parts = eventParts(e, now, book);
      expect(line({ actor: e.actor, parts })).toBe(words);
      expect(parts.filter((p) => p.strong).length).toBe(1);
    }
  });

  test("a move says the folder it went to, as a person names it", () => {
    const e = ev.move(1, "ws-p", "0-inbox/receipt-from-figma.md", "2-areas/receipt-from-figma.md", WHO.sorter);
    expect(line({ actor: e.actor, parts: eventParts(e, false, book) })).toBe("Inbox sorter moved Receipt from Figma to Areas");
    expect(line({ actor: e.actor, parts: eventParts(e, true, book) })).toBe("Inbox sorter is moving Receipt from Figma to Areas");
    const top = ev.move(1, "ws-p", "0-inbox/receipt-from-figma.md", "receipt-from-figma.md", WHO.sorter);
    expect(line({ actor: top.actor, parts: eventParts(top, false, book) })).toBe("Inbox sorter moved Receipt from Figma to the top level");
  });

  test("a move between workspaces names the workspace and the folder", () => {
    const seyi = { id: "p:seyi", kind: "person" as const, name: "Seyi" };
    const e = ev.move(1, "ws-p", "0-inbox/call-with-dana.md", "1-projects/call-with-dana.md", seyi, "ws-s");
    // The title is the note's where it landed.
    expect(line({ actor: e.actor, parts: eventParts(e, false, book) })).toBe("Seyi moved Call with Dana to Supa › Projects");
  });

  test("a hostile file name is isolated rather than reversing the line", () => {
    const evil = graph("ws-x", "X", ["a‮evil.md"]);
    const parts = eventParts(ev.read(1, "ws-x", "a‮evil.md"), false, nameBook([evil]));
    expect(parts[1]!.text).not.toBe("a‮evil");
    expect(parts[1]!.text).toContain("evil");
  });
});

describe("the live feed", () => {
  const now = 1_000_000;
  const actors: MapActor[] = [
    { id: WHO.maya.id, kind: "person", name: "Maya", path: "1-projects/pricing.md", doing: "read", at: now, workspaceId: "ws-p" },
    { id: WHO.claude.id, kind: "agent", name: "Seyi's Claude", path: "2-areas/finance.md", doing: "read", at: now - 5_000, workspaceId: "ws-p" },
    // A tool whose last call was minutes ago is not "reading" any more.
    { id: "a:old", kind: "agent", name: "Codex", path: "index.md", doing: "edit", at: now - 5 * 60_000, workspaceId: "ws-p" },
    { id: "p:idle", kind: "person", name: "Ruth", path: null, doing: "idle", at: now, workspaceId: "ws-p" },
  ];
  const events = [
    ev.read(now - 5_000, "ws-p", "2-areas/finance.md", WHO.claude),
    ev.read(now - 30_000, "ws-p", "1-projects/pricing.md", WHO.claude),
    ev.edit(now - 5 * 60_000, "ws-p", "index.md", { id: "a:old", kind: "agent", name: "Codex" }),
  ];

  test("what is happening now comes first, said once, and the rest in the past tense", () => {
    const feed = liveFeed({ actors, events, now, book });
    expect(feed.map(line)).toEqual([
      "Maya is reading Pricing",
      "Seyi's Claude is reading finance",
      "Seyi's Claude read Pricing",
      "Codex edited index",
    ]);
    expect(feed.map((item) => whenText(item, now))).toEqual(["now", "now", "just now", "5 min ago"]);
  });

  test("the viewer's own lines are left out", () => {
    const feed = liveFeed({ actors, events, now, book, selfId: WHO.maya.id });
    expect(feed.map(line)).not.toContain("Maya is reading Pricing");
  });

  test("times read as a person says them", () => {
    expect(whenText({ now: true, at: 0 }, 0)).toBe("now");
    expect(whenText({ now: false, at: 0 }, 59_000)).toBe("just now");
    expect(whenText({ now: false, at: 0 }, 2 * 60_000)).toBe("2 min ago");
    expect(whenText({ now: false, at: 0 }, 3 * 3_600_000)).toBe("3 hr ago");
  });
});

describe("the replay's feed", () => {
  const t0 = new Date(2026, 9, 7, 11, 0).getTime();
  const events = [
    ev.read(t0, "ws-p", "1-projects/pricing.md", WHO.maya),
    ev.edit(t0 + 60_000, "ws-p", "1-projects/pricing.md", WHO.maya),
    ev.move(t0 + 10 * 60_000, "ws-p", "0-inbox/receipt-from-figma.md", "2-areas/receipt-from-figma.md", WHO.sorter),
  ];

  test("only what had happened by the playhead, each actor's latest step as happening", () => {
    const feed = replayFeed({ events, t: t0 + 90_000, book });
    expect(feed.map(line)).toEqual(["Maya is editing Pricing", "Maya read Pricing"]);
    expect(feed.map((item) => clockText(item.at))).toEqual(["11:01 am", "11:00 am"]);
  });

  test("a step long finished is in the past tense", () => {
    const feed = replayFeed({ events, t: t0 + 30 * 60_000, book });
    expect(feed.map(line)).toEqual(["Inbox sorter moved Receipt from Figma to Areas", "Maya edited Pricing", "Maya read Pricing"]);
  });
});

describe("who is working", () => {
  test("people and AI tools are counted apart, each once", () => {
    const p = (id: string) => ({ id, kind: "person" as const });
    const a = (id: string) => ({ id, kind: "agent" as const });
    expect(workingNowLine([p("1"), p("2"), a("3"), a("4"), a("5"), a("6")])).toBe("2 people, 4 AI tools");
    expect(workingNowLine([p("1"), p("1")])).toBe("1 person");
    expect(workingNowLine([a("1")])).toBe("1 AI tool");
    expect(workingNowLine([])).toBe("Nobody is working here right now");
  });
});

describe("moves between workspaces", () => {
  test("one row per direction, counted in the window, busiest first", () => {
    const seyi = { id: "p:seyi", kind: "person" as const, name: "Seyi" };
    const events = [
      ev.move(10, "ws-p", "0-inbox/a.md", "1-projects/a.md", seyi, "ws-s"),
      ev.move(20, "ws-p", "0-inbox/b.md", "1-projects/b.md", seyi, "ws-s"),
      ev.move(30, "ws-s", "1-projects/c.md", "0-inbox/c.md", seyi, "ws-p"),
      ev.move(40, "ws-p", "0-inbox/d.md", "1-projects/d.md", seyi),
      ev.move(5, "ws-p", "0-inbox/e.md", "1-projects/e.md", seyi, "ws-s"),
    ];
    const rows = crossMoveRows(events, 10, 100, book);
    expect(rows.map((r) => `${r.fromName} → ${r.toName} ${r.count}`)).toEqual(["Personal → Supa 2", "Supa → Personal 1"]);
  });
});
