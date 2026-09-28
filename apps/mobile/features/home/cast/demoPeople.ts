import type { CastStep } from "@context/shared";
import type { ActivePerson, AgentActivityView } from "../../console/agents/agentActivity";
import { castMemberId } from "./castRun";

/**
 * How many people the homepage's bar says have the workspace open.
 *
 * A demo number, and the only invented thing on the bar: the homepage draws
 * the console's own activity bar (`ActiveParts`) in visitor mode, and a
 * workspace of one visitor would show no people at all. Dev2 asked for the
 * demo to show a crowd, then for a smaller, less round one (2026-09-28). The
 * faces are the cast's own people, so the circles on the bar are the carets
 * the visitor watches type.
 */
export const HOMEPAGE_PEOPLE_ACTIVE = 13;

/** The people the owner scripted into the site's pages, each once, in their cast colour. */
export function castPeople(steps: readonly CastStep[], colors: ReadonlyMap<string, string>): ActivePerson[] {
  const people = new Map<string, ActivePerson>();
  for (const step of steps) {
    if (step.kind === "wait" || step.actor.kind !== "person") continue;
    const id = castMemberId(step.actor);
    if (!people.has(id)) {
      people.set(id, { id, name: step.actor.name, color: colors.get(step.actor.name) ?? null, self: false });
    }
  }
  return [...people.values()];
}

/** The cast's agents, if any, with the demo's people on the same bar. */
export function withDemoPeople(
  agents: AgentActivityView | undefined,
  people: readonly ActivePerson[],
): AgentActivityView {
  return {
    agents: agents?.agents ?? [],
    marks: agents?.marks ?? [],
    people,
    peopleCount: Math.max(HOMEPAGE_PEOPLE_ACTIVE, people.length),
  };
}
