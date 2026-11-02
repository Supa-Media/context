/**
 * Why one scope of an access copy failed, in words safe for a public job log
 * (`functions/accessObjects.ts` returns these to the "Access objects backfill"
 * workflow, whose function logs go nowhere). Never an id, a handle, an address,
 * a hash or a token:
 *
 * - an object's refusal (`TexObjectRefused`, a 422) keeps its message only when
 *   it is plain words, as the contract's fixed refusals are
 *   (`apps/mcp/src/workspaceStore/access.js`); anything with an id-like word is
 *   `refused`.
 * - an object's other answer is `object_<op>_<status>`.
 * - anything else is `failureOf`'s closed error name and reason.
 */

import { failureOf } from "../workspaceObjects/failures";

/** Plain words, numbers standing alone, and light punctuation: what a fixed refusal is made of. */
const PLAIN = /^[A-Za-z][A-Za-z0-9 ,'()-]{0,119}$/;
/** A word of 8 or more mixing letters and digits, or a long run of either: the shape of an id or a hash. */
const ID_LIKE = /(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{8,}|[A-Za-z0-9]{25,}/;

export function accessFailureKind(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const message = typeof (error as { message?: unknown } | null)?.message === "string" ? (error as { message: string }).message : "";
  if (name === "TexObjectRefused") return PLAIN.test(message) && !ID_LIKE.test(message) ? `refused: ${message}` : "refused";
  const answered = /^Tex store ([a-z]+(?:\.[a-z]+){0,3}) failed \((\d{3})\)$/i.exec(message);
  if (answered) return `object_${answered[1]}_${answered[2]}`;
  const failure = failureOf(error);
  return `${failure.error}:${failure.reason}`;
}

/** Adds one failure to a run's tally: at most `cap` distinct kinds, the rest counted under `other`. */
export function tally(failures: { kind: string; count: number }[], kind: string, cap = 10): void {
  const key = failures.some((entry) => entry.kind === kind) || failures.length < cap ? kind : "other";
  const held = failures.find((entry) => entry.kind === key);
  if (held) held.count += 1;
  else failures.push({ kind: key, count: 1 });
}
