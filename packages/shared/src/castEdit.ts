/**
 * Changing a cast one step at a time, the way the studio's script rail does.
 *
 * The note stays the script (Dev2, 2026-09-30: "directly edit script content
 * here, edit timing, characters, text"): every change here is a new version of
 * the page's own text, with the lines of the step it changed rewritten and
 * every other line of the page, cast block or not, left exactly as written.
 * A step is written back in the grammar's plainest words (`castStepLine`), so
 * a changed step reads the way the grammar's own examples do.
 *
 * Pure and dependency-free, like the grammar in `websiteCast.ts`.
 */

import { castStepSources, splitWebsiteCast, type CastActor, type CastStep } from "./websiteCast";

/** One line of text, as a step's words must be: the grammar reads a line at a time. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Seconds as a person writes them: `1.5s`, `2s`. */
function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/** Quoted words for "comments on", in the quotes that cannot end them early. */
function quoted(words: string): string {
  const one = oneLine(words);
  return one.includes('"') ? `“${one.replace(/”/g, '"')}”` : `"${one}"`;
}

/** A step as the grammar's own examples write it; a note's body follows on indented lines. */
export function castStepLine(step: CastStep): string {
  if (step.kind === "wait") return `wait ${seconds(step.ms)}`;
  if (step.kind === "keyboard") return `keyboard: ${step.on ? "on" : "off"}`;
  if (step.kind === "shows") return `shows: ${step.what === "context" ? "Context" : step.what}`;
  const who = step.actor.name;
  switch (step.kind) {
    case "line":
      return `${who} ${step.actor.kind === "agent" ? "writes" : "types"}: ${oneLine(step.text)}`;
    case "append":
      return `${who} adds ${step.below === true ? "a line below" : "to the line above"}: ${oneLine(step.text)}`;
    case "read":
      return step.page === null ? `${who} reads` : `${who} reads: ${oneLine(step.page)}`;
    case "note": {
      const body = step.text === "" ? [] : step.text.split("\n").map((line) => (line.trim() === "" ? "" : `  ${line}`));
      const name = step.folder === undefined ? oneLine(step.name) : `${step.folder}/${oneLine(step.name)}`;
      return [`${who} adds note: ${name}`, ...body].join("\n");
    }
    case "comment":
      return `${who} comments on ${quoted(step.quote)}: ${oneLine(step.text)}`;
    case "reply":
      return `${who} replies: ${oneLine(step.text)}`;
    case "resolve":
      return `${who} resolves`;
    case "join":
      return `${who} joins`;
    case "leave":
      return `${who} leaves`;
    case "click":
      return `${who} clicks ${step.target}`;
    case "tick":
      return `${who} ticks: ${oneLine(step.quote)}`;
    case "open":
      return `${who} opens: ${oneLine(step.page)}`;
    case "ask":
      return `${who} asks ${step.agent}: ${oneLine(step.text)}`;
    case "answer":
      return `${who} answers: ${oneLine(step.text)}`;
    case "folder":
      return `${who} adds folder: ${step.path}`;
    case "move":
      return `${who} moves ${step.path} into: ${step.into}`;
    case "rename":
      return `${who} renames ${step.path} to: ${oneLine(step.name)}`;
    case "status":
      return `${who} marks ${step.path} as: ${oneLine(step.status)}`;
    case "task":
      return `${who} adds task to ${step.project}: ${oneLine(step.text)}`;
  }
}

/** The words a row lets you type over, or `null` for a step that has none. */
export function castStepWords(step: CastStep): string | null {
  switch (step.kind) {
    case "line":
    case "append":
    case "comment":
    case "reply":
    case "ask":
    case "answer":
    case "task":
      return step.text;
    case "folder":
      return step.path;
    case "move":
      return step.into;
    case "rename":
      return step.name;
    case "status":
      return step.status;
    case "tick":
      return step.quote;
    case "open":
      return step.page;
    case "read":
      return step.page ?? "";
    case "note":
      return step.name;
    case "wait":
      return String(Math.round(step.ms / 100) / 10);
    default:
      return null;
  }
}

/** The step with its words replaced; `null` when the words would not make a step. */
export function withCastWords(step: CastStep, words: string): CastStep | null {
  const text = oneLine(words);
  switch (step.kind) {
    case "line":
    case "append":
    case "comment":
    case "reply":
    case "ask":
    case "answer":
    case "task":
      return text === "" ? null : { ...step, text };
    case "folder":
      return text === "" ? null : { ...step, path: text };
    case "move":
      return text === "" ? null : { ...step, into: text };
    case "rename":
      return text === "" ? null : { ...step, name: text };
    case "status":
      return text === "" ? null : { ...step, status: text.toLowerCase() };
    case "tick":
      return text === "" ? null : { ...step, quote: text };
    case "open":
      return text === "" ? null : { ...step, page: text };
    case "read":
      return { ...step, page: text === "" ? null : text };
    case "note":
      return text === "" ? null : { ...step, name: text };
    case "wait": {
      const amount = Number(text.replace(/\s*s(ec(ond)?s?)?$/i, ""));
      return Number.isFinite(amount) && amount > 0 ? { kind: "wait", ms: Math.round(amount * 1000) } : null;
    }
    default:
      return null;
  }
}

/** The step done by somebody else. A wait or a cut has nobody to change. */
export function withCastActor(step: CastStep, actor: CastActor): CastStep {
  return "actor" in step ? { ...step, actor } : step;
}

/** The kinds of step a row can be switched between, in the order the editor offers them. */
export const CAST_EDIT_KINDS = ["line", "comment", "reply", "resolve", "open", "join", "leave", "wait"] as const;
export type CastEditKind = (typeof CAST_EDIT_KINDS)[number];

/**
 * The step turned into another kind, keeping who does it and its words where
 * the new kind has words. `actor` stands in when the step was a wait.
 */
export function withCastKind(step: CastStep, kind: CastEditKind, actor: CastActor): CastStep {
  const who = "actor" in step ? step.actor : actor;
  const words = castStepWords(step) ?? "";
  const text = words === "" || !("actor" in step) ? "…" : words;
  switch (kind) {
    case "line":
      return { kind: "line", actor: who, text, at: 0 };
    case "comment":
      return { kind: "comment", actor: who, quote: step.kind === "comment" ? step.quote : "…", text };
    case "reply":
      return { kind: "reply", actor: who, text };
    case "resolve":
      return { kind: "resolve", actor: who };
    case "open":
      return { kind: "open", actor: who, page: step.kind === "open" ? step.page : "…" };
    case "join":
      return { kind: "join", actor: who };
    case "leave":
      return { kind: "leave", actor: who };
    case "wait":
      return { kind: "wait", ms: step.kind === "wait" ? step.ms : 1000 };
  }
}

/** An actor as a name is written: `@maya` is a person, anything else an agent. */
export function castActorNamed(name: string): CastActor | null {
  const written = oneLine(name).replace(/’/g, "'");
  const probe = splitWebsiteCast(`\`\`\`cast\n${written} joins\n\`\`\``).steps[0];
  return probe !== undefined && probe.kind === "join" && probe.actor.name === written ? probe.actor : null;
}

function lines(source: string): string[] {
  return source.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * The page with step `index` written as `step`, or taken out when `step` is
 * `null`. The page as it was when there is no such step.
 */
export function replaceCastStep(source: string, index: number, step: CastStep | null): string {
  const span = castStepSources(source)[index];
  if (span === undefined) return source;
  const all = lines(source);
  all.splice(span.from, span.to - span.from, ...(step === null ? [] : castStepLine(step).split("\n")));
  return all.join("\n");
}

/**
 * The page with `step` added so it becomes step `index`: before the step now
 * there, or after the last one. A page with no steps gets it in its first cast
 * block; a page with no cast block is returned as it is.
 */
export function insertCastStep(source: string, index: number, step: CastStep): string {
  const spans = castStepSources(source);
  const all = lines(source);
  let at: number;
  if (spans.length === 0) {
    const open = all.findIndex((line) => /^ {0,3}`{3,}\s*cast\s*$/i.test(line));
    if (open === -1) return source;
    at = open + 1;
  } else if (index < spans.length) {
    at = spans[Math.max(0, index)]!.from;
  } else {
    // After the last step, before any blank lines that ended a note's body.
    at = spans[spans.length - 1]!.to;
    while (at > spans[spans.length - 1]!.from + 1 && all[at - 1]!.trim() === "") at -= 1;
  }
  all.splice(at, 0, ...castStepLine(step).split("\n"));
  return all.join("\n");
}

/** The page with step `from` moved to be step `to`, the rest in their order. */
export function moveCastStep(source: string, from: number, to: number): string {
  const steps = splitWebsiteCast(source).steps;
  const step = steps[from];
  if (step === undefined || to < 0 || to >= steps.length || to === from) return source;
  const spans = castStepSources(source);
  const all = lines(source);
  const moving = all.slice(spans[from]!.from, spans[from]!.to);
  all.splice(spans[from]!.from, moving.length);
  const without = all.join("\n");
  const rest = castStepSources(without);
  const target = to < rest.length ? rest[to]!.from : rest[rest.length - 1]!.to;
  const after = lines(without);
  after.splice(target, 0, ...moving);
  return after.join("\n");
}

/** Everyone the script names, in the order they first appear. */
export function castActors(source: string): CastActor[] {
  const seen = new Map<string, CastActor>();
  for (const step of splitWebsiteCast(source).steps) {
    if ("actor" in step && !seen.has(step.actor.name)) seen.set(step.actor.name, step.actor);
  }
  return [...seen.values()];
}

/** The page with `from` renamed `to` in every step that names them: as doer, as the face clicked, or as the assistant asked. */
export function renameCastActor(source: string, from: string, to: CastActor): string {
  const steps = splitWebsiteCast(source).steps;
  let out = source;
  // Last to first, so each step's lines are still where the parser said.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (!("actor" in step)) continue;
    const doer = step.actor.name === from;
    const clicked = step.kind === "click" && step.target === from;
    const asked = step.kind === "ask" && step.agent === from && to.kind === "agent";
    if (!doer && !clicked && !asked) continue;
    let renamed: CastStep = doer ? { ...step, actor: to } : step;
    if (renamed.kind === "click" && clicked) renamed = { ...renamed, target: to.name };
    if (renamed.kind === "ask" && asked) renamed = { ...renamed, agent: to.name };
    out = replaceCastStep(out, index, renamed);
  }
  return out;
}
