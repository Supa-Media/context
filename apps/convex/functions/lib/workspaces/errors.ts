/**
 * Refusals shared by the `workspaces.ts` Convex functions.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row.
 */

import { ConvexError } from "convex/values";
import type { FolderRejection } from "../scaffold";
import {
  MAX_CUSTOM_FOLDERS,
  MAX_FOLDER_DESCRIPTION_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
} from "../scaffold";

/** The refusal, worded so the person can act on it. Names no key and no bucket. */
export function folderRejectionError(
  reason: FolderRejection,
  folder: string | undefined,
): ConvexError<{ code: string; message: string; reason: string }> {
  const named = folder === undefined ? "That folder name" : `"${folder}"`;
  const message: Record<FolderRejection, string> = {
    "too-many": `A starting layout can have at most ${MAX_CUSTOM_FOLDERS} folders. You can add more later.`,
    empty: "Every folder needs a name.",
    untrimmed: `${named} starts or ends with a space. Folder names become part of every file's path, so spaces at the edges are too easy to lose.`,
    "too-long": `${named} is longer than ${MAX_FOLDER_NAME_LENGTH} characters.`,
    "control-character":
      "A folder name contains a character that cannot appear in a file path.",
    backslash: `${named} contains a backslash. Use a plain name — this is one folder, not a path.`,
    "not-a-single-segment": `${named} contains a slash. Name one folder; you can nest inside it afterwards.`,
    traversal: `${named} is not a folder name.`,
    hidden: `${named} starts with a dot. Names beginning with a dot are reserved for plumbing and are hidden from every client.`,
    reserved: `${named} is the name of a file this context already creates.`,
    duplicate: `${named} is listed twice.`,
    "description-empty": `${named} needs a one-line description. It becomes that folder's README.`,
    "description-too-long": `The description for ${named} is longer than ${MAX_FOLDER_DESCRIPTION_LENGTH} characters.`,
    "description-control-character": `The description for ${named} must be a single line.`,
  };
  return new ConvexError({
    code: "INVALID_FOLDER",
    message: message[reason],
    // A code from a closed set, so an interface can point at the offending
    // field without matching on English.
    reason,
  });
}

/**
 * The refusal for a member this workspace does not have.
 *
 * Safe to be distinct from every other error here, and distinct on purpose:
 * only an `owner` reaches this line, and an owner can already enumerate their
 * own members with `listMembers`. There is nothing for the refusal to disclose,
 * and "that person is not in this context" is the only form of it they can act
 * on.
 */
export function memberNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "MEMBER_NOT_FOUND",
    message: "That person is not a member of this context.",
  });
}
