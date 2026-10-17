/**
 * Who may move what between two workspaces, and the sentence a failed move
 * shows. Split out of `contextMoves.ts` so the engine there stays one file a
 * reader can hold; shared by the console's actions and the gateway's.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { requireWorkspaceRole } from "./workspaceAuth";

export async function authorizeMove(
  ctx: Parameters<typeof requireWorkspaceRole>[0],
  args: {
    sourceWorkspaceId: Id<"workspaces">;
    destinationWorkspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    from: string;
    to: string;
  },
): Promise<void> {
  if (args.sourceWorkspaceId === args.destinationWorkspaceId) {
    /*
      Not a cross-context move at all, and refusing beats quietly doing the
      slower thing. `files.moveEntry` is the operation for this: it rewrites
      every link that pointed at what moved, which this one cannot do and does
      not pretend to. Routing a same-context move through here would silently
      break references for the one case where following them is possible.
    */
    throw new ConvexError({
      code: "SAME_CONTEXT",
      message: "That is a move within one context. Use the ordinary move, which also fixes links.",
    });
  }
  const from = normalizeMovePath(args.from);
  const to = normalizeMovePath(args.to);
  if (from === "" || to === "") {
    throw new ConvexError({
      code: "PATH_INVALID",
      message: "A move needs a note or folder to move and somewhere to put it.",
    });
  }

  // Source first, so somebody who owns neither is refused by the context they
  // are taking from rather than by the one they are giving to — which is also
  // the only one of the two whose existence they have proven anything about.
  await requireWorkspaceRole(ctx, args.sourceWorkspaceId, args.actorUserId, "owner");
  await requireWorkspaceRole(ctx, args.destinationWorkspaceId, args.actorUserId, "editor");
}

/**
 * Trim the slashes a path picker can leave on either end.
 *
 * The engine's own `requirePath` rejects rather than repairs, which is right
 * for a key arriving from a tool call. This is the console's own dialog, and a
 * trailing slash on a folder somebody picked is not an error worth showing
 * them.
 */
export function normalizeMovePath(input: string): string {
  return input.replace(/^\/+/, "").replace(/\/+$/, "").trim();
}

const UNEXPECTED = "The move could not be completed. Nothing further was moved.";
export const TOO_MANY_PASSES =
  "This move is taking more passes than expected and has stopped. Everything already moved is in the new context; run it again to finish.";

export function messageOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return data.message;
  }
  return error instanceof Error && error.message !== "" ? error.message : UNEXPECTED;
}
