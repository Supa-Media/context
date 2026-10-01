import { castStepWords, splitWebsiteCast, type CastActor, type CastPaceName, type CastStep } from "@context/shared";
import { stripFrontmatter } from "../share/markdown";
import { castTimeline, type CastTimeline } from "../home/cast/castTimeline";
import { paceNamed } from "../home/cast/castRun";

/** One row of the studio's script. */
export interface ScriptRow {
  index: number;
  /** Who does it; `null` for a wait. */
  actor: CastActor | null;
  /** What they do, in a few words: `types “p.s. this page is live.”`. */
  says: string;
  /** When it starts, in ms; `null` for a step that never runs (a reply to nothing). */
  at: number | null;
  /** The step itself, for the rail to change. */
  step: CastStep;
  /** What they do, without the words: `replies`, `comments on “Free is free”`. */
  verb: string;
  /** The words the row lets you type over, or `null` for a step that has none. */
  words: string | null;
}

export interface StudioScript {
  rows: ScriptRow[];
  timeline: CastTimeline;
  /** Lines the cast grammar did not understand, for the author. */
  problems: string[];
  /** How fast it plays: its `pace:` line, or lively. */
  pace: CastPaceName;
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
      return step.folder === undefined ? `adds the note ${step.name}` : `adds the note ${step.name} to ${step.folder}`;
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
    case "ask":
      return `asks ${step.agent} ${quoted(step.text)}`;
    case "answer":
      return `answers ${quoted(step.text)}`;
    case "folder":
      return `adds the folder ${step.path}`;
    case "move":
      return `moves ${step.path} into ${step.into}`;
    case "rename":
      return `renames ${step.path} to ${step.name}`;
    case "status":
      return `marks ${step.path} as ${step.status}`;
    case "task":
      return `adds a task to ${step.project} ${quoted(step.text)}`;
    case "wait":
      return `Wait ${Math.round(step.ms / 100) / 10}s`;
    case "keyboard":
      return step.on ? "A phone's keyboard comes up for typing" : "No phone keyboard";
    case "shows":
      return step.what === "both" ? "The phone shows both apps" : `The phone shows ${step.what === "context" ? "Context" : step.what}`;
  }
}

/** What a step does, as a row says it before the words that can be typed over. */
export function describeVerb(step: CastStep): string {
  switch (step.kind) {
    case "line":
      return step.actor.kind === "agent" ? "writes" : "types";
    case "append":
      return step.below === true ? "adds a line below" : "adds to the line above";
    case "read":
      return step.page === null ? "reads this note" : "reads";
    case "note":
      return "adds the note";
    case "reply":
      return "replies";
    case "comment":
      return `comments on ${quoted(step.quote)}`;
    case "tick":
      return "ticks";
    case "open":
      return "opens";
    case "ask":
      return `asks ${step.agent}`;
    case "answer":
      return "answers";
    case "folder":
      return "adds the folder";
    case "move":
      return `moves ${step.path} into`;
    case "rename":
      return `renames ${step.path} to`;
    case "status":
      return `marks ${step.path} as`;
    case "task":
      return `adds a task to ${step.project}`;
    case "wait":
      return "Pause";
    default:
      return describeStep(step);
  }
}

/** A note's script, as the studio's rail and scrubber show it; `pages` are the ones it opens, by name. */
export function studioScript(source: string, pages: Readonly<Record<string, string>> = {}): StudioScript {
  const { markdown, steps, problems, pace } = splitWebsiteCast(stripFrontmatter(source));
  const timeline = castTimeline(markdown, steps, pages, paceNamed(pace));
  return {
    rows: steps.map((step, index) => ({
      index,
      actor: "actor" in step ? step.actor : null,
      says: describeStep(step),
      at: timeline.starts[index] ?? null,
      step,
      verb: describeVerb(step),
      words: step.kind === "read" && step.page === null ? null : castStepWords(step),
    })),
    timeline,
    problems,
    pace: pace ?? "lively",
  };
}
