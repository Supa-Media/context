/**
 * ROUTINES SET FROM A GROUP CHAT (the owner, 2026-10-27;
 * `docs/decisions/texting-assistant/chat-routines.md`).
 *
 * A routine in a shared workspace runs only when its front matter names the
 * chat it answers into (`chat:`, the first 16 hex of the chat's key). The
 * control plane hands it out only while that chat is bound to the workspace,
 * and the texting Worker runs it as its writer's tag in that chat, so it
 * answers where everyone it concerns reads it and never into one person's
 * texts.
 *
 * So a routine written from a chat must carry this chat's id: a new one
 * without it would sit in the folder and never run, and one naming another
 * chat is refused here. A guest chat reads only a corner of the workspace and
 * sets none; nor does somebody with no account, whose turn runs on the
 * binder's grant: the routine would run as the binder.
 */

import { chatRoutineId, frontMatter, homeRoutineWords, routineRootOf } from "../../../../packages/shared/src/routines.cjs";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";

/** Every path-like argument a routine could be named by. */
export const routinePaths = (args) =>
  [args?.path, args?.note, args?.destination].filter((value) => typeof value === "string" && routineRootOf(value) !== null);

/** Why a write to a routine from this chat is refused, or null when it may go. */
export function chatRoutineRefusal(group, name, args) {
  const paths = routinePaths(args);
  if (paths.length === 0) return null;
  // A routine in a chat's home answers into that chat (`chatHome.js`): only this chat's own, and only by somebody on Context.
  const homed = paths.filter((path) => homeRoutineWords(path) !== null);
  if (homed.length > 0) {
    if (group?.guestTagger) return "Only someone here who is on Context can set a reminder or routine for this chat; ask one of them to.";
    const home = typeof group?.home?.folder === "string" ? `${group.home.folder}/routines/` : null;
    if (home === null || homed.some((path) => !path.toLowerCase().startsWith(home))) return "That is another chat's folder: set this chat's routines in its own.";
    if (homed.length === paths.length) return null;
  }
  if (group?.guestChat) return "Reminders and routines can't be set from a guest chat: it reads only its own corner of the workspace. Text me on your own for one.";
  if (group?.guestTagger) return "Only someone here who is on Context can set a reminder or routine for this chat; ask one of them to.";
  const id = chatRoutineId(group?.key);
  if (id === null) return "Reminders and routines can't be set from this chat.";
  // A new routine's words: it must name this chat, or it never runs.
  if (name === "write_note" && typeof args?.content === "string") {
    const chat = (frontMatter(args.content).chat ?? "").trim().toLowerCase();
    if (chat !== id) {
      return `Not saved: a routine set from this chat answers into it. Put chat: ${id} in its front matter, between the --- lines, and save it again.`;
    }
  }
  return null;
}

/** What a group turn is told about routines. */
export function chatRoutinePrompt(group) {
  if (typeof group?.home?.folder === "string" && !group.guestTagger) {
    return (
      `You can set reminders and routines for this chat. Write one in this chat's own folder at ${group.home.folder}/routines/<how-often>/<name>.md, ` +
      `with context: "${PINNED_CONTEXT_NAME}" on the call; the lines are a routine's usual ones, and it answers here because it is in this chat's folder. ` +
      "When it is due it runs as the person who asked for it, and you answer it here for everyone, never in anyone's own texts; it stays quiet when it has nothing to say. " +
      "Only the people in this chat can see and change it. When someone asks to stop one, archive it yourself at once. " +
      CHECK_IN_LINE
    );
  }
  const id = chatRoutineId(group?.key);
  if (group?.guestChat || id === null) return "You can't set reminders or routines from this chat. ";
  return (
    "You can set reminders and routines for this chat. Write one in this workspace at tex/routines/<how-often>/<name>.md, " +
    `with chat: ${id} in its front matter (between --- lines) so it answers here; the other lines are a routine's usual ones. ` +
    "When it is due it runs as the person who asked for it, on this workspace's team notes, and you answer it here for everyone, " +
    "never in anyone's own texts; it stays quiet when it has nothing to say. Anyone here can see and change it in the app. " +
    "When someone asks to stop one, archive it yourself at once. " +
    CHECK_IN_LINE
  );
}

const CHECK_IN_LINE =
  "You also check in on this chat on your own, a few times a day and soon after mail shared here arrives, posting only what it needs: " +
  "nobody sets that up, so if asked to keep an eye on things, say you already do. ";
