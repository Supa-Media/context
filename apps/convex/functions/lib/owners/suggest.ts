/**
 * Who the note says should own it: the question Jev is asked for an owner
 * picker's "Suggested" row, and how its answer is read. Pure, so both halves
 * are tested without a model.
 *
 * Jev picks one of the options it is given and never writes text, so the
 * options are exactly what the picker could offer anyway — the people the
 * search ranked first, the connected agents the caller may already see, and
 * "any agent" — plus a way out. It always picks something, so the way out is
 * an option of its own ("none of these"), and an answer that is not one of
 * the keys offered is no answer. Confidence is not thresholded: the way out
 * is how Jev says it does not know (docs/decisions/folder-lists.md).
 *
 * What it reads is the one note being assigned, and nothing else. A locked
 * note is ciphertext to the control plane and is never sent; a note that says
 * `organize: off` asked for no AI reading and gets none.
 */

import { noteProperties } from "../../../../mcp/src/lists/properties.js";

/** What an owner line says when any connected agent may pick the work up. */
export const ANY_AGENT = "any agent";
/** Of a note, what Jev reads: about 4K tokens, well inside its window. */
export const SUGGEST_BODY_CHARS = 16_000;
/** A note with less to read than this after its frontmatter names nobody. */
const MIN_BODY_CHARS = 12;

export interface OwnerCandidates {
  readonly people: readonly string[];
  readonly agents: readonly string[];
}

export interface NoteToRead {
  readonly text: string;
  readonly encrypted: boolean;
}

export type SuggestedOwner = { value: string; kind: "person" | "agent" | "any" };

const NONE = "none_of_these";
const ANY = "any_agent";

function bodyOf(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/**
 * Whether this note may be read for an owner at all, and has anything in it
 * to read. Checked before a request is built, so a skipped note is never
 * part of one.
 */
export function mayRead(note: NoteToRead): boolean {
  if (note.encrypted) return false;
  const organize = noteProperties(note.text).organize;
  if (typeof organize === "string" && organize.trim().toLowerCase() === "off") return false;
  return bodyOf(note.text).trim().length >= MIN_BODY_CHARS;
}

/** The option keys, in the order offered, and what each one writes. */
export function ownerOptions(candidates: OwnerCandidates): Map<string, SuggestedOwner | null> {
  const options = new Map<string, SuggestedOwner | null>();
  candidates.people.forEach((value, at) => options.set(`person_${at + 1}`, { value, kind: "person" }));
  candidates.agents.forEach((value, at) => options.set(`agent_${at + 1}`, { value, kind: "agent" }));
  options.set(ANY, { value: ANY_AGENT, kind: "any" });
  options.set(NONE, null);
  return options;
}

/** The request for one note. `mayRead` has already said yes. */
export function ownerRequest(text: string, candidates: OwnerCandidates): { state: string; questions: Record<string, unknown> } {
  const criteria: Record<string, string> = {};
  for (const [key, option] of ownerOptions(candidates)) {
    criteria[key] =
      option === null ? "None of these: the note does not make clear who should do this work"
      : option.kind === "person" ? `${option.value}, a person in this workspace`
      : option.kind === "agent" ? `${option.value}, an AI agent connected to this workspace`
      : "Any AI agent: the note hands this work to an agent, whichever picks it up";
  }
  const state = text.length > SUGGEST_BODY_CHARS ? `${text.slice(0, SUGGEST_BODY_CHARS)}\n[…]` : text;
  return {
    state,
    questions: {
      owner: {
        type: "choice",
        instructions:
          "Who should own the work this note describes? Pick the person or agent the note names, assigns it to, or says is doing it. If it names nobody, pick None of these.",
        criteria,
      },
    },
  };
}

/** Jev's answer as an owner to suggest, or null for "none of these" and anything unexpected. */
export function readOwnerAnswer(answers: Record<string, unknown> | null, candidates: OwnerCandidates): SuggestedOwner | null {
  const answer = answers?.owner as { type?: unknown; choice?: unknown } | undefined;
  if (answer?.type !== "choice" || typeof answer.choice !== "string") return null;
  return ownerOptions(candidates).get(answer.choice) ?? null;
}
