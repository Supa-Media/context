/**
 * The app's Copy and Duplicate of one note, made by the gateway for a workspace whose notes live in its object
 * (`POST /files/copy`, `/files/duplicate`, served by `fileOpsRoute.js`): the copy's text is put under a new note id,
 * which the object adopts as a new row (`ws.write.adopt`), with the bucket's backup copy and Convex's row following
 * behind. The control plane is not asked on the way
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`, "Copies in the object").
 *
 * Only the plain case is taken, and the rest answers `defer`, which the app sends to `files.copyEntry` /
 * `files.duplicateEntry` as before:
 * - a folder, or a file that is not a Markdown note (a picture, a PDF);
 * - a source with its own exception (an exact rule, a group or person grant), or one seen through anything but the
 *   two tiers: carrying an exception is the control plane's (`copyPrivacy`);
 * - anything under a chat's sealed home.
 *
 * What travels is the control plane's rule: a note that was private only because of its folder stays private when its
 * copy lands in a team folder, and otherwise the copy takes its new folder's tier. The text is the note's current text,
 * its shared-editing document where it has one, as `copyPath` reads it.
 *
 * Answers `{ok: true, from, to}`, `{ok: false, code}` with `not_found`, `taken`, `invalid_path`, `forbidden`, or
 * `defer`.
 */

import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import { recordChange } from "../activity/record.js";
import { isEncryptedNote } from "../encryption.js";
import { inChatHome } from "../agent/chatHomeSeal.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { canSee, hasOverride, isPlumbing, visibilityOf } from "../privacy/engine.js";
import { loadPrivacyState, persistExactVisibility } from "../privacy/state.js";

const TIERS = new Set(["private", "team"]);
const refusal = (code) => ({ ok: false, code });

/** The parent folder of `path`, or "" at the top. */
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

/** `x copy.md`, then `x copy 2.md`, … as the control plane's `duplicateName` picks them. */
export function duplicateNames(path) {
  const name = nameOf(path);
  const parent = parentOf(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const at = (candidate) => (parent === "" ? candidate : `${parent}/${candidate}`);
  return function* names() {
    yield at(`${stem} copy${extension}`);
    for (let counter = 2; ; counter += 1) yield at(`${stem} copy ${counter}${extension}`);
  };
}

/** How many "… copy N" names Duplicate tries before it leaves the choice to the control plane. */
export const DUPLICATE_TRIES = 20;

/**
 * Whether `caller` may copy `from` and what the copy's tier is, or a refusal. `rules`/`overrides` are this request's.
 * The source is judged first, so a source the caller cannot see is `not_found` wherever they aimed it.
 */
function judge({ scope, groups }, from, to, rules, overrides) {
  if (!canSee(from, scope, rules, overrides, groups)) return { refused: refusal("not_found") };
  // A source with its own exception, or one seen through a group or a person: the control plane carries those.
  const source = visibilityOf(from, rules);
  if (hasOverride(overrides, from) || !TIERS.has(source)) return { refused: refusal("defer") };
  const folder = visibilityOf(to, rules);
  if (!TIERS.has(folder) || hasOverride(overrides, to)) return { refused: refusal("defer") };
  // A team caller writes only where the team may: the move's own check (`tools/moves/note.js`).
  if (scope !== "private" && folder !== "team") return { refused: refusal("forbidden") };
  // Private only because of its folder: the copy stays private in a team folder (`copyPrivacy`'s inherited case).
  const tier = source === "private" || folder === "private" ? "private" : "team";
  return { tier, carry: source === "private" && folder === "team" };
}

/** The note's current text: its shared-editing document where it has one, else what is stored. */
async function currentText(store, path) {
  const object = await getWithLegacyFallback(store, path);
  if (object === null) return null;
  const stored = await object.text();
  if (!collaborationSupported(store) || isEncryptedNote(stored) || !collaborationEligible(path, stored)) return stored;
  const document = await readCollaborationDocument(store, path);
  return typeof document?.text === "string" ? document.text : stored;
}

/**
 * Copies the note at `from` to `to` for `caller` (`{scope, groups}`, this session's: `groups` is the session's Set of
 * names, as `canSee` reads it), on `store` (the request's).
 * A destination is judged before it is looked up: one the caller may not write to is `forbidden` (or `defer` where
 * it carries its own rule) whether or not something is there, so nothing hidden is named by `taken`.
 */
export async function copyNote(store, caller, fromArg, toArg) {
  const from = normalizePath(fromArg);
  const to = normalizePath(toArg);
  if (!from || !to || from === to || isPlumbing(from) || isPlumbing(to)) return refusal("invalid_path");
  if (!from.toLowerCase().endsWith(".md") || !to.toLowerCase().endsWith(".md")) return refusal("defer");
  if (inChatHome(store, from) || inChatHome(store, to)) return refusal("defer");
  const { rules, overrides, error } = await loadPrivacyState(store);
  if (error) return refusal("defer");
  const judged = judge(caller, from, to, rules, overrides);
  if (judged.refused) return judged.refused;
  if (!(await probeWithLegacyFallback(store, from))) return refusal("not_found");
  if (await probeWithLegacyFallback(store, to)) return refusal("taken");

  let text;
  try {
    text = await currentText(store, from);
  } catch {
    // A shared-editing document that could not be read: the control plane refuses it the same way.
    return refusal("defer");
  }
  if (text === null) return refusal("not_found");
  // The tier first, so the copy is never seen wider than its source for a moment (`write.js` does the same).
  if (judged.carry) await persistExactVisibility(store, to, "private", rules);
  const put = await store.put(to, text, { onlyIf: { absent: true }, tier: judged.tier });
  // Taken while this ran. A narrowing written above stays: taking it back could publish the other writer's note
  // (`moves/objects.js` `clearExactVisibilityIfAbsent` says why), and a stale private rule is the safe direction.
  if (!put) return refusal("taken");
  // The copy is made: its bookkeeping may fail without failing it, or the app would make a second copy.
  try {
    await recordChange(store, "copy_note", caller.scope, [to], { copiedFrom: from });
  } catch {
    // The search derivatives catch up on their next pass; the audit line is the one thing lost.
  }
  return { ok: true, from, to };
}

/** Copies the note at `path` beside itself under the first free "… copy" name. */
export async function duplicateNote(store, caller, pathArg) {
  const path = normalizePath(pathArg);
  if (!path) return refusal("invalid_path");
  const names = duplicateNames(path)();
  for (let tried = 0; tried < DUPLICATE_TRIES; tried += 1) {
    const answer = await copyNote(store, caller, path, names.next().value);
    if (answer.ok || answer.code !== "taken") return answer;
  }
  return refusal("defer");
}
