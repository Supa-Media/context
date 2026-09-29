/**
 * The `managedEncryption` option for a store the control plane builds itself
 * (console file operations, the hand-off copy), and the sibling
 * `/gateway/binding` sends the gateway. One lookup, so the console, an AI
 * client and a hand-off all read a workspace in the same mode.
 *
 * Fails closed: a workspace in a mode whose key cannot be opened gets no
 * store at all. Built without the wrapper, a sealed note would be served as
 * bytes and could be saved over.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayEncryptionMode } from "./state";

export type ManagedEncryptionOption = {
  workspaceId: string;
  mode: GatewayEncryptionMode;
  current: string;
  keys: Record<string, string>;
};

export async function managedEncryptionOption(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<ManagedEncryptionOption | null> {
  const mode: GatewayEncryptionMode | null = await ctx.runQuery(
    internal.functions.managedEncryption.gatewayMode,
    { workspaceId },
  );
  if (mode === null) return null;
  const key: { current: string; keys: Record<string, string> } | null = await ctx.runAction(
    internal.functions.encryptionKeys.openWorkspaceDataKey,
    { workspaceId },
  );
  if (key === null || typeof key.keys[key.current] !== "string") {
    throw new ConvexError({ code: "KEY_UNAVAILABLE", message: "This workspace's files can't be opened right now." });
  }
  return { workspaceId: String(workspaceId), mode, current: key.current, keys: key.keys };
}

/** The one refusal a person sees for a sealed file that will not open. */
export function encryptedUnreadable(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "ENCRYPTED_UNREADABLE",
    message: "This note can't be opened right now. It's still in storage.",
  });
}

/**
 * Turn the gateway store's `ManagedEncryptionError` into that refusal.
 * Anything else passes through untouched.
 */
export function rethrowUnreadable(error: unknown): never {
  if ((error as { name?: unknown })?.name === "ManagedEncryptionError") throw encryptedUnreadable();
  throw error;
}

/**
 * The email worker's two siblings beside an ingest binding, or `null` when the
 * lookup failed. Unlike the note cap, a failed lookup is no binding: a plain
 * store over a sealed bucket would write the message in the clear into a
 * workspace that refuses plain.
 */
export async function ingestEncryptionSiblings(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<
  | Record<string, never>
  | {
      managedEncryption: { mode: ManagedEncryptionOption["mode"] };
      encryptionKey: { current: string; keys: Record<string, string> };
    }
  | null
> {
  let managed: ManagedEncryptionOption | null;
  try {
    managed = await managedEncryptionOption(ctx, workspaceId);
  } catch {
    return null;
  }
  if (managed === null) return {};
  return {
    managedEncryption: { mode: managed.mode },
    encryptionKey: { current: managed.current, keys: managed.keys },
  };
}
