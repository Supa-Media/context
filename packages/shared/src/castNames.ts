/**
 * The words every cast line is made of: who does a step, and how long its
 * words may be. Shared by the grammar (`websiteCast.ts`) and its terminal
 * steps (`castTerminal.ts`), so a name means the same in both.
 */

import type { CastActor } from "./websiteCast";

export const MAX_CAST_TEXT = 600;

/** An assistant's name: up to three words, `Claude Code` included. */
export const NAME = String.raw`[A-Za-z][A-Za-z0-9._-]{0,30}(?: [A-Za-z0-9][A-Za-z0-9._-]{0,30}){0,2}`;
/** `@maya`, `Claude`, or somebody's agent: `@jon's Claude`. */
export const ACTOR = String.raw`(@[A-Za-z0-9][A-Za-z0-9_.-]{0,38}(?:['’]s ${NAME})?|${NAME})`;
export const AGENT_NAME = new RegExp(String.raw`^${NAME}$`);

export function actor(written: string): CastActor {
  // A person is `@handle`; `@handle's Claude` is that person's agent.
  const name = written.replace(/’/g, "'");
  return { name, kind: name.startsWith("@") && !name.includes("'s ") ? "person" : "agent" };
}

export function clip(text: string): string {
  return text.trim().slice(0, MAX_CAST_TEXT);
}

/**
 * The lines indented two spaces or more under line `i` (blank ones between
 * them included), with those two spaces taken off: a note's text, a
 * command's output, an edit's diff. `next` is the last line they took.
 */
export function indentedBody(lines: readonly string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let next = i;
  while (next + 1 < lines.length && (/^\s{2,}\S/.test(lines[next + 1]!) || lines[next + 1]!.trim() === "")) {
    next += 1;
    body.push(lines[next]!.replace(/^\s{2}/, ""));
  }
  return { body, next };
}
