/**
 * THE HOMEPAGE'S BAR IS THE CONSOLE'S BAR — `features/home/cast/demoPeople.ts`.
 *
 * The homepage draws the console's own activity bar with demo numbers. What
 * can go wrong is a homepage-only shape: agents from the cast dropped when
 * people are added, a person listed twice for speaking twice, or an agent
 * drawn as a person.
 */

import { describe, expect, test } from "@jest/globals";
import type { CastStep } from "@context/shared";
import { activeParts, agentsLine } from "../features/console/agents/agentActivity";
import { HOMEPAGE_PEOPLE_ACTIVE, castPeople, withDemoPeople } from "../features/home/cast/demoPeople";

const steps: CastStep[] = [
  { kind: "line", actor: { name: "@maya", kind: "person" }, text: "hi", at: 0 },
  { kind: "line", actor: { name: "@maya", kind: "person" }, text: "again", at: 0 },
  { kind: "read", actor: { name: "@jon's Claude", kind: "agent" }, page: null },
  { kind: "line", actor: { name: "@jon", kind: "person" }, text: "yo", at: 0 },
];

describe("the homepage's people", () => {
  test("each cast person once, in their colour, and no agents", () => {
    const people = castPeople(steps, new Map([["@maya", "#e0457b"]]));
    expect(people.map((person) => [person.name, person.color])).toEqual([["@maya", "#e0457b"], ["@jon", null]]);
  });

  test("the demo crowd joins the cast's agents on the one bar", () => {
    const agents = [{ id: "a:cast-x", name: "x", color: null, at: 1, kind: "read" as const, path: "a.md", reads: 1, writes: 0 }];
    const view = withDemoPeople({ agents, marks: [] }, castPeople(steps, new Map()));
    expect(agentsLine(view)).toBe(`${HOMEPAGE_PEOPLE_ACTIVE} people and 1 agent active`);
    expect(agentsLine(withDemoPeople(undefined, []))).toBe(`${HOMEPAGE_PEOPLE_ACTIVE} people active`);
    expect(activeParts(view)).toEqual({ people: "13 ppl,", agents: "1 agent active" });
  });
});
