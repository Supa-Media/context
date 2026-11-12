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
 * chat is refused here. A chat that reaches no shared workspace keeps its
 * routines in its home, as every chat may (the owner, 2026-11-12: "all group
 * chats should be the same"); somebody with no account sets none, since a
 * routine runs as its writer.
 */

import { chatRoutineId, frontMatter, isHomeRoutinePath, routineRootOf } from "../../../../packages/shared/src/routines.cjs";

const pathArgs = (args) => [args?.path, args?.note, args?.destination].filter((value) => typeof value === "string");

/** Every path-like argument a routine could be named by. */
export const routinePaths = (args) => pathArgs(args).filter((value) => routineRootOf(value) !== null);

/**
 * Every path-like argument naming a routine in a chat's home (`tex/groups/<words>/routines/`, with
 * `context: "@context-lc"`). Since 2026-11-02 a chat's routines live there (the owner: "we have to be able to see it");
 * the control plane reads their times and answers each into the home's own chat, so no `chat:` line is needed
 * (`apps/convex/functions/lib/routines/homes.ts`).
 */
export const homeRoutinePaths = (args) =>
  pathArgs(args).filter((value) => isHomeRoutinePath(value.trim().replace(/^@[^/]*\/+/, "")));

/** Where this chat keeps its routines, or null without a home. */
export function chatRoutinesFolder(group) {
  return typeof group?.home?.folder === "string" ? `${group.home.folder}/routines` : null;
}

/** Why a write to a routine from this chat is refused, or null when it may go. */
export function chatRoutineRefusal(group, name, args) {
  const inHome = homeRoutinePaths(args).length > 0;
  if (routinePaths(args).length === 0 && !inHome) return null;
  // A chat that reaches no shared workspace keeps its routines in its home, like any chat (the owner, 2026-11-12).
  if (group?.guestChat && !inHome) return chatRoutinesFolder(group) === null ? "Reminders and routines can't be set from this chat." : `Put this chat's routines in its folder, ${chatRoutinesFolder(group)}/<how-often>/ (context: "@context-lc"): it reaches no shared workspace to keep one in.`;
  if (group?.guestTagger) return "Only someone here who is on Context can set a reminder or routine for this chat; ask one of them to.";
  const id = chatRoutineId(group?.key);
  if (id === null) return "Reminders and routines can't be set from this chat.";
  // In the home the chat is the home's: nothing in the note names it (`homes.ts`).
  if (inHome) return null;
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
  const id = chatRoutineId(group?.key);
  const folder = chatRoutinesFolder(group);
  if (id === null || (group?.guestChat && folder === null)) return "You can't set reminders or routines from this chat. ";
  const where =
    folder === null
      ? "Write one in this workspace at tex/routines/<how-often>/<name>.md, " +
        `with chat: ${id} in its front matter (between --- lines) so it answers here; the other lines are a routine's usual ones. `
      : `Write one in this chat's folder at ${folder}/<how-often>/<name>.md (context: "@context-lc"), with a routine's usual front matter; ` +
        "it answers here on its own, and you and everyone here can read what is set by listing that folder. ";
  return (
    "You can set reminders and routines for this chat. " +
    where +
    "When it is due it runs as the person who asked for it, on this workspace's team notes, and you answer it here for everyone, " +
    "never in anyone's own texts; it stays quiet when it has nothing to say. Anyone here can see and change it in the app. " +
    // A home's notes never leave it (its seal refuses a move), so one there is stopped where it is.
    (folder === null ? "When someone asks to stop one, archive it yourself at once. " : "When someone asks to stop one, set paused: yes in its front matter yourself at once. ") +
    "You also check in on this chat on your own, a few times a day and soon after mail shared here arrives, posting only what it needs: " +
    "nobody sets that up, so if asked to keep an eye on things, say you already do. "
  );
}
