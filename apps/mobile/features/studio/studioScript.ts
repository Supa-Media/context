import { splitWebsiteCast, type CastActor, type CastStep } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { castTimeline, type CastTimeline } from "../home/cast/castTimeline";

/** One row of the studio's script. */
export interface ScriptRow {
  index: number;
  /** Who does it; `null` for a wait. */
  actor: CastActor | null;
  /** What they do, in a few words: `types “p.s. this page is live.”`. */
  says: string;
  /** When it starts, in ms; `null` for a step that never runs (a reply to nothing). */
  at: number | null;
}

export interface StudioScript {
  rows: ScriptRow[];
  timeline: CastTimeline;
  /** Lines the cast grammar did not understand, for the author. */
  problems: string[];
}

const QUOTE_MAX = 60;

function quoted(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `“${one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1)}…` : one}”`;
}

/** What a step does, as a row says it after the actor's name. */
export function describeStep(step: CastStep): string {
  switch (step.kind) {
    case "line":
      return `${step.actor.kind === "agent" ? "writes" : "types"} ${quoted(step.text)}`;
    case "append":
      return `adds ${quoted(step.text)}`;
    case "read":
      return step.page === null ? "reads this note" : `reads ${step.page}`;
    case "note":
      return `adds the note ${step.name}`;
    case "comment":
      return `comments on ${quoted(step.quote)}`;
    case "reply":
      return `replies ${quoted(step.text)}`;
    case "resolve":
      return "resolves the comment";
    case "join":
      return "comes in";
    case "leave":
      return "leaves";
    case "click":
      return `clicks ${step.target}`;
    case "tick":
      return `ticks ${quoted(step.quote)}`;
    case "open":
      return `opens ${step.page}`;
    case "wait":
      return `Wait ${Math.round(step.ms / 100) / 10}s`;
  }
}

/** A note's script, as the studio's rail and scrubber show it; `pages` are the ones it opens, by name. */
export function studioScript(source: string, pages: Readonly<Record<string, string>> = {}): StudioScript {
  const { markdown, steps, problems } = splitWebsiteCast(stripFrontmatter(source));
  const timeline = castTimeline(markdown, steps, pages);
  return {
    rows: steps.map((step, index) => ({
      index,
      actor: step.kind === "wait" ? null : step.actor,
      says: describeStep(step),
      at: timeline.starts[index] ?? null,
    })),
    timeline,
    problems,
  };
}
