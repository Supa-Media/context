/**
 * What a console's `/agent-activity` poll may say about its own person.
 *
 * The poll has always been the person's heartbeat (`peopleActive.js`). For the
 * live map it may also say two more things, as query parameters:
 *
 *  - **where they are**: `note=<path>&doing=read|edit` — the note they have
 *    open, and whether they are editing it.
 *  - **what they just did**: `did=create&path=<path>`, or
 *    `did=move&from=<path>&to=<path>` — a create or move the console finished
 *    through the control plane, which no tool call ever told this feed about.
 *
 * Both are the person's own claim about the workspace, which every other
 * member's map will draw. So neither is taken on trust:
 *
 *  - **Only the console's own client speaks for a person.** A tool calling
 *    this route is an agent, recorded by its tool calls, and is never given a
 *    face or a voice here.
 *  - **Every path must be one the caller can see and that is really there.**
 *    `canSee` for the caller's scope against the live `privacy.md`, groups as
 *    private, plumbing never — and the bucket says the note exists. A path
 *    that fails is dropped silently: the answer is the same either way, so
 *    the parameter cannot be used to ask whether something hidden exists.
 *    That is also why the existence probe runs whether or not `canSee`
 *    passed, by the reasoning `handlePresence` gives at length: a refusal that
 *    skipped the bucket only for hidden paths would be cheaper exactly when
 *    something is being held back.
 *  - **A move must have happened.** `to` must exist and `from` must not, so a
 *    person cannot draw a move between two notes that are both still there.
 *    A create must exist. Both need write: a member who cannot write did not
 *    move anything.
 *  - **Editing needs write**, or it is reported as reading.
 *
 * What a person may announce is narrower than what an agent may: a note, not
 * a folder (a console folder move is seen at the next listing), and never a
 * read or an edit, which the `note`/`doing` presence already says.
 *
 * Nothing here is stored durably. It rides the same in-memory window as the
 * rest of the activity object, and a poll that carries none of it costs
 * exactly what a poll cost before.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { isConsoleActor, presenceDisplayName } from "./presence.js";
import { normalizePath } from "../notes/paths.js";
import { objectExists } from "../storageLayout.js";
import { presenceClientKey } from "./relayAuthorization.js";

/**
 * Whether `path` is a note this caller can see, and whether it is there.
 *
 * The same two-step probe as `handlePresence`: a metadata check for
 * everyone, then the logical view (a tombstone, a pending folder move) only
 * once the caller is allowed to know.
 */
async function lookUp(store, path, visible) {
  const physical = await objectExists(store, path, { metadataOnly: true });
  const present = visible && physical ? await objectExists(store, path) : physical;
  return { visible, present };
}

function notePath(raw) {
  const path = normalizePath(raw);
  return path && !isPlumbing(path) ? path : null;
}

/**
 * The `x-activity-person` value for this poll, or `null` when the caller is
 * not a person (any client but the console).
 */
export async function heartbeatPerson(session, store, privacy, params) {
  if (!isConsoleActor({ clientId: session.actorClientId })) return null;
  const key = await presenceClientKey(`person:${session.actorUserId}`);
  if (key === null) return null;
  const person = { key, name: presenceDisplayName(session) };
  const sees = (path) => canSee(path, session.scope, privacy.rules, privacy.overrides);
  const writes = hasScope(session, SCOPE_WRITE);

  const open = params.has("note") ? notePath(params.get("note")) : null;
  if (open) {
    const found = await lookUp(store, open, sees(open));
    if (found.visible && found.present) {
      person.note = { path: open, doing: writes && params.get("doing") === "edit" ? "edit" : "read" };
    }
  }

  const did = params.get("did");
  if (did === "create" && writes) {
    const path = notePath(params.get("path"));
    if (path) {
      const found = await lookUp(store, path, sees(path));
      if (found.visible && found.present) person.did = { kind: "create", path };
    }
  } else if (did === "move" && writes) {
    const from = notePath(params.get("from"));
    const to = notePath(params.get("to"));
    if (from && to && from !== to) {
      const source = await lookUp(store, from, sees(from));
      const destination = await lookUp(store, to, sees(to));
      if (source.visible && destination.visible && !source.present && destination.present) {
        person.did = { kind: "move", from, path: to };
      }
    }
  }
  return person;
}
