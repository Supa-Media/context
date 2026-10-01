/**
 * Developer casts: an assistant at work in a terminal (Dev2, 2026-10-01, "it
 * won't just be claude and chatgpt it will be claude code and codex and we
 * need to be able to show them doing tasks running commands, and filling out
 * project details in context and updating project statuses").
 *
 * ````
 * ```cast
 * terminal: Codex in ~/shop-api
 * @sam asks Codex: fix the double charge when a payment retries
 * Codex runs: pnpm test payments
 *   ✓ 38 passed
 *   ✗ refunds › partial refund after retry
 * Codex edits: payments/retry.ts
 *   - return chargeCard(order)
 *   + return chargeCard(order, { key: order.id })
 * Codex asks to run: git push
 * @sam allows
 * Codex marks checkout-v2 as: in progress
 * ```
 * ````
 *
 * An assistant that runs a command, edits a file or asks to run one has a
 * terminal instead of a chat window, whether or not a `terminal:` line names
 * it; the line only says which folder it is in. Everything else it does
 * (reading a note, ticking a task, marking a project done) shows in that
 * terminal as Context work, beside the workspace changing.
 *
 * A terminal looks like no product in particular, as a chat does not. Pure
 * and dependency-free, like the rest of the grammar (`websiteCast.ts`).
 */

import { ACTOR, AGENT_NAME, actor, clip, indentedBody } from "./castNames";
import type { CastActor, CastStep } from "./websiteCast";

/** The steps only a terminal has. */
export type CastTerminalStep =
  /** A command and what it printed, a line at a time. */
  | { kind: "run"; actor: CastActor; command: string; output: string[] }
  /** A file changed, as its diff: lines starting `-` went, `+` came. */
  | { kind: "edit"; actor: CastActor; file: string; diff: string[] }
  /** The assistant asking before it runs a command; the next `allows` or `denies` answers it. */
  | { kind: "approve"; actor: CastActor; command: string }
  /** Somebody answering the last command an assistant asked to run. */
  | { kind: "allow"; actor: CastActor; allowed: boolean };

/** An assistant that works in a terminal, and the folder its prompt shows. */
export interface CastTerminal {
  agent: string;
  folder: string;
}

/** Bounds: a command's output and an edit's diff stay a screenful. */
export const MAX_CAST_OUTPUT_LINES = 16;
const MAX_OUTPUT_LINE = 200;

const RUN = new RegExp(String.raw`^${ACTOR}\s+runs\s*:\s*(.+)$`, "i");
const EDIT = new RegExp(String.raw`^${ACTOR}\s+edits\s*:\s*(.+)$`, "i");
const APPROVE = new RegExp(String.raw`^${ACTOR}\s+asks to run\s*:\s*(.+)$`, "i");
const ALLOW = new RegExp(String.raw`^${ACTOR}\s+(allows|approves|says yes|denies|declines|says no)(?:\s+it)?$`, "i");
const TERMINAL = /^terminal\s*:\s*(.+?)(?:\s+in\s+(\S.*))?$/i;

/** Output lines as written: the body's own indent kept, trailing blanks gone, and a screenful at most. */
function printed(body: readonly string[]): string[] {
  const lines = body.map((line) => line.trimEnd().slice(0, MAX_OUTPUT_LINE));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, MAX_CAST_OUTPUT_LINES);
}

/**
 * Line `i` as a terminal step, pushed onto `steps` (or a problem onto
 * `problems`): the last line it read, its output or diff included. `null`
 * when the line is not a terminal step at all, for the rest of the grammar.
 */
export function parseTerminalStep(
  lines: readonly string[],
  i: number,
  steps: CastStep[],
  problems: string[],
): number | null {
  const text = lines[i]!.trim();
  const onlyAgents = (who: CastActor) => {
    if (who.kind === "agent") return true;
    problems.push(`Only an assistant runs commands or edits files here, like Codex: ${text.slice(0, 120)}`);
    return false;
  };
  let match: RegExpExecArray | null;
  if ((match = APPROVE.exec(text)) !== null) {
    const who = actor(match[1]!);
    if (onlyAgents(who)) steps.push({ kind: "approve", actor: who, command: clip(match[2]!) });
    return i;
  }
  if ((match = RUN.exec(text)) !== null || (match = EDIT.exec(text)) !== null) {
    const run = RUN.test(text);
    const { body, next } = indentedBody(lines, i);
    const who = actor(match[1]!);
    if (!onlyAgents(who)) return next;
    if (run) steps.push({ kind: "run", actor: who, command: clip(match[2]!), output: printed(body) });
    else steps.push({ kind: "edit", actor: who, file: clip(match[2]!).slice(0, 200), diff: printed(body) });
    return next;
  }
  if ((match = ALLOW.exec(text)) !== null) {
    if (!steps.some((step) => step.kind === "approve")) {
      problems.push(`Nothing has asked to run a command yet: ${text.slice(0, 120)}`);
      return i;
    }
    const allowed = !/^(denies|declines|says no)$/i.test(match[2]!);
    steps.push({ kind: "allow", actor: actor(match[1]!), allowed });
    return i;
  }
  return null;
}

/**
 * A `terminal:` line: the assistant and its folder, or a sentence saying what
 * was not understood. `null` when the line is not one.
 */
export function terminalLine(text: string): CastTerminal | string | null {
  const match = TERMINAL.exec(text);
  if (match === null) return null;
  const agent = match[1]!.trim();
  if (!AGENT_NAME.test(agent)) return `Not an assistant to give a terminal: ${agent.slice(0, 60)}. Try terminal: Codex in ~/shop-api.`;
  return { agent, folder: (match[2] ?? "~").trim().slice(0, 80) };
}

/** How many terminals one scene names: a few windows, never a page of them. */
export const MAX_CAST_TERMINALS = 6;

/** `terminals` with `one` in it, replacing any earlier line for the same assistant; past the bound, the first ones stay. */
export function withTerminal(terminals: readonly CastTerminal[] | undefined, one: CastTerminal): CastTerminal[] {
  const others = (terminals ?? []).filter((terminal) => terminal.agent.toLowerCase() !== one.agent.toLowerCase());
  return others.length >= MAX_CAST_TERMINALS ? others : [...others, one];
}

/** Every assistant the steps show running, editing or asking to run, given a terminal when no line gave one. */
export function terminalsOf(steps: readonly CastStep[], named: readonly CastTerminal[] | undefined): CastTerminal[] | undefined {
  let terminals = named === undefined ? undefined : [...named];
  for (const step of steps) {
    if (step.kind !== "run" && step.kind !== "edit" && step.kind !== "approve") continue;
    if (terminals?.some((terminal) => terminal.agent.toLowerCase() === step.actor.name.toLowerCase())) continue;
    terminals = [...(terminals ?? []), { agent: step.actor.name, folder: "~" }];
  }
  return terminals;
}

/** A terminal step as the grammar's own examples write it, its output or diff on indented lines. */
export function terminalStepLine(step: CastTerminalStep): string {
  const who = step.actor.name;
  const body = (lines: readonly string[]) => lines.map((line) => (line === "" ? "" : `  ${line}`));
  switch (step.kind) {
    case "run":
      return [`${who} runs: ${step.command}`, ...body(step.output)].join("\n");
    case "edit":
      return [`${who} edits: ${step.file}`, ...body(step.diff)].join("\n");
    case "approve":
      return `${who} asks to run: ${step.command}`;
    case "allow":
      return `${who} ${step.allowed ? "allows" : "denies"}`;
  }
}

/** The page's `terminal:` lines for `from`, inside its cast blocks, naming `to` instead. */
export function renameTerminal(source: string, from: string, to: string): string {
  let cast: string | null = null;
  return source
    .split("\n")
    .map((line) => {
      if (cast === null) {
        cast = /^ {0,3}(`{3,})\s*cast\s*$/i.exec(line)?.[1] ?? null;
        return line;
      }
      if (line.trim().length >= cast.length && [...line.trim()].every((c) => c === "`")) {
        cast = null;
        return line;
      }
      const terminal = terminalLine(line.trim());
      if (terminal === null || typeof terminal === "string" || terminal.agent !== from) return line;
      return line.replace(/^(\s*terminal\s*:\s*)(.+?)(\s+in\s+\S.*)?$/i, (_all, head: string, _name: string, tail?: string) => `${head}${to}${tail ?? ""}`);
    })
    .join("\n");
}
