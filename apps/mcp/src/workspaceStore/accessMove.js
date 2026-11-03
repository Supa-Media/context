/**
 * A move's narrowing, decided in the workspace object (`apps/convex/functions/lib/nodes/setAccess.ts`
 * `narrowRowsForMoves`, the control plane's): a row moved where it would be seen wider than where it stood takes base
 * `private` (or `team`, the narrower of the two tiers) on its own row, before the move, so the move carries it. A row
 * whose base is already that is left alone, and nothing else is rewritten: a child that inherits follows its parent.
 *
 * `narrowForMoves(ctx, moves)` runs inside the caller's transaction (a tree op that moves rows calls it first) and
 * returns the mirror's change, or null when no move narrowed. `ws.write.narrowMoves` is the same as an op of its own.
 * Each move is judged by the rules the moves before it left, as the control plane judges a batch.
 */

import { effectiveVisibility, narrowerVisibility, PrivacyOverrides, visibilityOf } from "../privacy/engine.js";
import { judgingSet, keepRules, WAIT_FOR_MIRROR } from "./accessWrite.js";
import { WriteOpRefused } from "./writeRefusal.js";

const MAX_MOVES = 500;
const text = (value) => typeof value === "string" && value !== "" && value.length <= 1024 && !value.includes("\0");
const tierOf = (visibility) => (visibility === "team" ? "team" : "private");

/** The member rules as the privacy engine reads them. */
function judged(rules) {
  const overrides = new PrivacyOverrides();
  for (const note of rules.notes) overrides.set(note.path, note.visibility);
  return { folders: rules.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides };
}

/**
 * Pin each moved row that would widen. `null` when none did (or there is no set to decide by: the caller then
 * leaves the narrowing to the control plane). Otherwise the change for the mirror.
 */
export function narrowForMoves(ctx, moves) {
  const set = judgingSet(ctx);
  if (set === null) return { ready: false, change: null };
  let rules = null;
  let version = null;
  const pinned = [];
  for (const { from, to } of moves) {
    rules ??= judged(ctx.access.render("member", undefined, ctx.now));
    const was = tierOf(effectiveVisibility(from, rules.folders, rules.overrides));
    const there = tierOf(visibilityOf(to, rules.folders));
    const carry = tierOf(narrowerVisibility(was, there) ?? "private");
    if (carry === there) continue;
    const row = ctx.rows.byPath(from);
    if (row === null) continue;
    const token = row.noteId ?? row.id;
    const held = ctx.access.set().rows.find((record) => record.token === token && record.kind === row.kind) ?? null;
    if (held?.base === carry) continue;
    version ??= Math.max(ctx.now, set.version + 1);
    ctx.access.writeRecord({ token, kind: row.kind, path: row.path, base: carry, grantees: held?.grantees ?? [] }, version);
    pinned.push({ rowId: row.id, base: carry });
    rules = null;
  }
  if (pinned.length === 0) return { ready: true, change: null };
  keepRules(ctx, version);
  return { ready: true, version, change: { op: "narrowBases", record: { rows: pinned, baseVersion: set.version, version }, objectAt: version } };
}

/** `ws.write.narrowMoves`: `{moves: [{from, to}]}`. Answers `{ok, version, pinned}`, or `NOT_READY`. */
export function narrowMoves(ctx, body) {
  if (!Array.isArray(body.moves) || body.moves.length === 0 || body.moves.length > MAX_MOVES) throw new WriteOpRefused("a narrowing names its moves");
  for (const move of body.moves) {
    if (!move || !text(move.from) || !text(move.to)) throw new WriteOpRefused("a move names where from and where to");
  }
  const result = narrowForMoves(ctx, body.moves);
  if (!result.ready) return { answer: { ok: false, code: "NOT_READY" }, change: null, narrows: false };
  if (result.change === null) return { answer: { ok: true, version: ctx.access.set().version, pinned: 0 }, change: null, narrows: false };
  return {
    answer: { ok: true, version: result.version, pinned: result.change.record.rows.length },
    change: result.change,
    narrows: WAIT_FOR_MIRROR,
    rules: true,
  };
}
