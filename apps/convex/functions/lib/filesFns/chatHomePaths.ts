/**
 * The paths of an operation that may name a note kept in a group chat's Durable Object (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A console store reaches only the Tex objects its ticket names (`store/texRouting.js`), so an operation on a note
 * under a chat's home must name that chat when the store is built. These are the paths it asks about
 * (`texChatLanding.chatsOfHomes`, which answers only for the pinned workspace and a path under exactly one home):
 *
 * - a move landing notes, every destination;
 * - a read, a batch read or a save, its paths under `tex/groups/`, where the homes are. Without this the app could
 *   list a chat's notes but not open one: the store refused the chat's key and the app showed "Your bucket did not
 *   complete that request" (2026-11-02).
 *
 * Which chats the caller may open is not decided here: the operation still reads through the rows' access rules, and
 * the store refuses any chat the paths did not name.
 */

const HOMES = "tex/groups/";

type Operation = { kind: string; [field: string]: unknown };

export function chatHomePaths(operation: Operation): string[] {
  if (operation.kind === "contextMoveImport") {
    const objects = operation.objects as Array<{ destination: string }>;
    return objects.map((object) => object.destination);
  }
  let paths: unknown[] = [];
  if (operation.kind === "read" || operation.kind === "write") paths = [operation.path];
  else if (operation.kind === "readMany") paths = Array.isArray(operation.paths) ? operation.paths : [];
  return paths.filter((path): path is string => typeof path === "string" && path.startsWith(HOMES));
}
