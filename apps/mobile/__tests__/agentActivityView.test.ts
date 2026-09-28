/**
 * WHICH ROWS SAY AN AGENT WAS HERE — `features/console/agents/agentActivity.ts`.
 *
 * The gateway has already filtered the answer to what this person may see.
 * What is left to get wrong here is the drawing: a mark on the wrong row, a
 * read shown over a write, a hundred agents turning into a hundred things in
 * the sidebar, or a malformed answer taking the explorer down.
 */

import { describe, expect, test } from "@jest/globals";
import {
  activeParts,
  agentMarkRows,
  agentsLine,
  agoShort,
  compactCount,
  decodeAgentActivity,
  peopleActive,
  describeAgent,
  type ActiveAgent,
  type AgentMark,
} from "../features/console/agents/agentActivity";

const mark = (path: string, kind: "read" | "write", at = 1): AgentMark => ({ path, kind, at, agent: "a:0123456789abcdef" });

describe("marks roll up to the nearest row that is drawn", () => {
  test("a note in an open folder is marked itself", () => {
    const rows = agentMarkRows([mark("1-projects/plan.md", "write")], new Set(["1-projects"]));
    expect([...rows]).toEqual([["1-projects/plan.md", "write"]]);
  });

  test("a note under a closed folder marks the folder", () => {
    const rows = agentMarkRows([mark("2-areas/apps/a.md", "read")], new Set());
    expect([...rows]).toEqual([["2-areas", "read"]]);
  });

  test("the first closed folder on the way down carries it, not the root", () => {
    const rows = agentMarkRows([mark("2-areas/apps/a.md", "read")], new Set(["2-areas"]));
    expect([...rows]).toEqual([["2-areas/apps", "read"]]);
  });

  test("a write outranks reads rolled into the same row, in either order", () => {
    const writeFirst = agentMarkRows(
      [mark("2-areas/a.md", "write"), mark("2-areas/b.md", "read")],
      new Set(),
    );
    const readFirst = agentMarkRows(
      [mark("2-areas/b.md", "read"), mark("2-areas/a.md", "write")],
      new Set(),
    );
    expect(writeFirst.get("2-areas")).toBe("write");
    expect(readFirst.get("2-areas")).toBe("write");
  });
});

describe("the foot says one line however many agents there are", () => {
  const agent = (id: string): ActiveAgent => ({
    id, name: id, color: null, at: 1, kind: "read", path: "a.md", reads: 1, writes: 0,
  });

  test("no agents is no line at all", () => {
    expect(agentsLine(undefined)).toBeNull();
    expect(agentsLine({ agents: [], marks: [] })).toBeNull();
  });

  test("one and many", () => {
    expect(agentsLine({ agents: [agent("a")], marks: [] })).toBe("1 agent active");
    const many = Array.from({ length: 120 }, (_, i) => agent(`a${i}`));
    expect(agentsLine({ agents: many, marks: [] })).toBe("120 agents active");
  });
});

describe("the gateway's answer is parsed, never trusted", () => {
  test("a well-formed answer comes through, newest agent first", () => {
    const view = decodeAgentActivity({
      marks: [{ path: "a.md", kind: "write", at: 5, agent: "a:1" }],
      agents: [
        { id: "a:1", name: "Old", color: "#3b82f6", at: 1, kind: "read", path: "a.md", reads: 1, writes: 0 },
        { id: "a:2", name: "New", color: "#10b981", at: 9, kind: "write", path: "b.md", reads: 0, writes: 2 },
      ],
    });
    expect(view.marks).toHaveLength(1);
    expect(view.agents.map((one) => one.name)).toEqual(["New", "Old"]);
  });

  test("malformed entries are dropped and the rest kept", () => {
    const view = decodeAgentActivity({
      marks: [null, { path: "a.md", kind: "deleting", at: 1, agent: "a:1" }, { path: "b.md", kind: "read", at: 2, agent: "a:1" }],
      agents: [{ id: "a:1", name: 5, color: "url(x)", at: 1, kind: "read", path: "b.md", reads: -3 }],
    });
    expect(view.marks.map((one) => one.path)).toEqual(["b.md"]);
    expect(view.agents[0]).toMatchObject({ name: "An agent", color: null, reads: 0, writes: 0 });
  });

  test("a name cannot carry direction overrides or line breaks into the sidebar", () => {
    const hostile = `Evil${String.fromCharCode(0x202e)}name${String.fromCharCode(0x2028)}\n`;
    const view = decodeAgentActivity({
      agents: [{ id: "a:1", name: hostile, color: null, at: 1, kind: "read", path: "a.md" }],
    });
    expect(view.agents[0].name).toBe("Evilname");
  });

  test("not an object at all is an empty answer", () => {
    expect(decodeAgentActivity(null)).toEqual({ agents: [], marks: [] });
    expect(decodeAgentActivity("nope")).toEqual({ agents: [], marks: [] });
  });
});

describe("the words say what happened, in the past tense", () => {
  const base: ActiveAgent = {
    id: "a:1", name: "Claude Code", color: null, at: 0, kind: "write", path: "1-projects/launch-plan.md", reads: 3, writes: 1,
  };

  test("one note is named, several are counted", () => {
    expect(describeAgent(base)).toBe("Wrote launch-plan");
    expect(describeAgent({ ...base, writes: 3 })).toBe("Wrote 3 notes");
    expect(describeAgent({ ...base, kind: "read", reads: 4 })).toBe("Read 4 notes");
    expect(describeAgent({ ...base, kind: "read", reads: 1, path: "faq.md" })).toBe("Read faq");
  });

  test("ages are short", () => {
    expect(agoShort(1_000, 2_000)).toBe("now");
    expect(agoShort(0, 20_000)).toBe("20s");
    expect(agoShort(0, 180_000)).toBe("3m");
  });
});

describe("people with the workspace open share the agents' bar", () => {
  const person = (id: string, self = false) => ({ id, name: `@${id}`, color: null, self });

  test("only the active number is shown, never the membership", () => {
    const view = { agents: [], marks: [], people: [person("me", true), person("maya")], peopleCount: 200 };
    expect(agentsLine(view)).toBe("200 people active");
  });

  test("people and agents are one line", () => {
    const agents = [{ id: "a:1", name: "Claude", color: null, at: 1, kind: "read" as const, path: "a.md", reads: 1, writes: 0 }];
    const view = { agents, marks: [], people: [person("me", true), person("jon")], peopleCount: 2 };
    expect(agentsLine(view)).toBe("2 people and 1 agent active");
    expect(activeParts(view)).toEqual({ people: "2 ppl,", agents: "1 agent active" });
  });

  test("the bar is short, with one active for the whole line", () => {
    const agents = [1, 2].map((n) => ({ id: `a:${n}`, name: "Claude", color: null, at: 1, kind: "read" as const, path: "a.md", reads: 1, writes: 0 }));
    const people = [person("me", true), person("jon")];
    expect(activeParts({ agents, marks: [], people, peopleCount: 13 })).toEqual({ people: "13 ppl,", agents: "2 agents active" });
    expect(activeParts({ agents: [], marks: [], people, peopleCount: 13 })).toEqual({ people: "13 ppl active", agents: null });
    expect(activeParts({ agents, marks: [], people: [person("me", true)], peopleCount: 1 })).toEqual({ people: null, agents: "2 agents active" });
  });

  test("you alone are not news, so a personal workspace shows no people", () => {
    expect(peopleActive({ agents: [], marks: [], people: [person("me", true)], peopleCount: 1 })).toBeNull();
    expect(agentsLine({ agents: [], marks: [], people: [person("me", true)], peopleCount: 1 })).toBeNull();
  });

  test("one other person, with the viewer not among those listed, still counts", () => {
    expect(agentsLine({ agents: [], marks: [], people: [person("maya")], peopleCount: 1 })).toBe("1 person active");
    expect(activeParts({ agents: [], marks: [], people: [person("maya")], peopleCount: 1 }).people).toBe("1 person active");
  });

  test("an older gateway with no people says nothing about people", () => {
    expect(peopleActive({ agents: [], marks: [] })).toBeNull();
  });

  test("large counts read as a size", () => {
    expect(compactCount(940)).toBe("940");
    expect(compactCount(2_000)).toBe("2k");
    expect(compactCount(2_450)).toBe("2.4k");
    expect(compactCount(12_900)).toBe("12k");
    expect(compactCount(1_250_000)).toBe("1.2m");
    expect(agentsLine({ agents: [], marks: [], people: [person("maya")], peopleCount: 2_000 })).toBe("2k people active");
  });

  test("people are parsed, cleaned and never under-counted", () => {
    const hostile = `Evil${String.fromCharCode(0x202e)}name`;
    const view = decodeAgentActivity({
      agents: [],
      marks: [],
      people: [{ id: "p:1", name: hostile, color: "#10b981", self: true }, { id: "", name: "x" }, { id: "p:2", name: 7 }],
      peopleCount: -4,
    });
    expect(view.people).toEqual([
      { id: "p:1", name: "Evilname", color: "#10b981", self: true },
      { id: "p:2", name: "Someone", color: null, self: false },
    ]);
    expect(view.peopleCount).toBe(2);
  });
});
