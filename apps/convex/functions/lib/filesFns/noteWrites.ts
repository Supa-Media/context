/**
 * Saving a note from the console, and taking a note's encryption off.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

/**
 * Save a note. Requires `editor`.
 *
 * `expectedEtag` is what the editor read. Omit it only to create a new file —
 * omitting it for an existing path is a conflict, not an overwrite. There is
 * no "force" flag; the console reloads and lets the person merge.
 */
export async function writeNoteHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    text: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "written" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "editor",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "write",
      path: args.path,
      text: args.text,
      expectedEtag: args.expectedEtag,
    },
  })) as Extract<OperationResult, { kind: "written" }>;

  // Paths and an outcome. Never the text — the schema's flat-scalar `details`
  // makes an accidental `{ body }` impossible, and this is the deliberate
  // half of that rule.
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: args.expectedEtag === undefined ? "file.create" : "file.write",
    paths: [result.path],
    details: { conflictCheck: result.conflictCheck },
  });
  return result;
}

/**
 * Remove a passphrase lock, replacing an encrypted note with plaintext.
 *
 * **Not `writeNote`, deliberately.** `writeFile`'s own widening lets an
 * envelope replace an envelope naming the same recipients — an edit while
 * unlocked, a passphrase change — and refuses plaintext over an encrypted note
 * in every case, so that an ordinary Save can never silently turn a lock off.
 * This is the separate, narrower door for the one legitimate plaintext-over-
 * encrypted write: reachable only from an explicit "Remove encryption" action
 * in the console, never from the editor's own Save.
 *
 * `minimum: "editor"`, the same as `writeNote` — the passphrase is what gates
 * this, not the workspace role. Anyone who can already write this note and
 * who was given the passphrase some other way (`docs/decisions/encryption.md`:
 * "sharing a note does not share its passphrase") may remove the lock they
 * were told how to open; nobody who lacks the passphrase can produce a
 * plaintext body this console will accept, because there is nothing here that
 * could have decrypted the note to produce one.
 */
export async function removeNoteEncryptionHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    text: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "written" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "editor",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "removeEncryption",
      path: args.path,
      text: args.text,
      expectedEtag: args.expectedEtag,
    },
  })) as Extract<OperationResult, { kind: "written" }>;

  // Paths and an outcome. Never the text, same as every other write here.
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.decrypt",
    paths: [result.path],
    details: { conflictCheck: result.conflictCheck },
  });
  return result;
}
