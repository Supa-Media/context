/**
 * The On screen node: what the person has open in the Context app when they text Tex from its chat (`../../screen.js`,
 * design D1 "Tex sees the open note"), read for the front door's per-text note. A wire from the front door
 * (`fd -> screen`, `uses`) turns it on; the front door starts it at its first step, on a 1:1 chat turn that is not a job.
 *
 * It answers only for the person's own app chat (`isAppTurn`): the app's texts run through the chat's queue like
 * iMessage and arrive as the texting client with the chat `app:<userId>`. Before this was a node, that gate named the
 * console's client alone and was a step nobody could see, so no app turn ever read the screen (2026-11-27, Dev: "do you
 * see the file I have open??" with a sheet open) and nothing showed it skipped.
 *
 * What it read stays on the turn (`t.screen`) and never rides on this node's output, which the chat's log keeps: the
 * output says only what kind of thing was open and how much of it was read, never a path, a word or a selection.
 * It never throws.
 *
 * Input `{}`. Output `{ when: ["found"], open, tabs, selection, chars }` or `{ when: ["none"], why }`.
 */
import { contextsFor } from "../../../../../../apps/mcp/src/context/identity.js";
import { isSheetPath } from "../../../../../shared/src/fileKinds.cjs";
import { isAppTurn, screenForTurn } from "../../screen.js";

export async function screenNode(_input, io) {
  const t = io?.ctx?.turn ?? null;
  if (t === null) return { when: ["none"], why: "no turn" };
  if (t.group !== null && t.group !== undefined) return { when: ["none"], why: "a group" };
  if (t.runner) return { when: ["none"], why: "a runner" };
  if (!isAppTurn(t.session, t.body)) return { when: ["none"], why: "not the app chat" };
  try {
    const read = await screenForTurn({ env: t.env, actorUserId: t.session.actorUserId, contexts: contextsFor(t.session), dispatch: t.dispatch, ownId: t.session.workspaceId, now: Date.now() });
    if (read === null) return { when: ["none"], why: "nothing open" };
    t.screen = read;
    const path = read.seen.note?.path;
    return {
      when: ["found"],
      open: path === undefined ? "none" : isSheetPath(path) ? "sheet" : "note",
      tabs: read.seen.tabs?.length ?? 0,
      selection: typeof read.seen.selection === "string",
      chars: typeof read.noteText === "string" ? read.noteText.length : 0,
    };
  } catch (error) {
    return { when: ["none"], why: `error:${typeof error?.name === "string" ? error.name : "error"}` };
  }
}
