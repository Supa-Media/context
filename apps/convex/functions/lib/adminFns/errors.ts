/**
 * Turning the staff console's internal error shapes into the same
 * `ConvexError` every other surface in this control plane throws.
 *
 * Split out of `functions/admin.ts` — see that file's header for the
 * credential-boundary rule this whole module exists under.
 */

import { ConvexError } from "convex/values";
import { AppSecretError } from "../appSecrets";
import { NotAdminError } from "../admin";

/**
 * `NotAdminError` and `AppSecretError` are internal shapes; the client sees a
 * `ConvexError` with a code, like every other surface in this control plane.
 *
 * The not-admin case is deliberately indistinguishable from a missing
 * endpoint: same code, same message, whether the caller is signed out, signed
 * in as a stranger, or signed in with an unverified allowlisted address.
 */
export function toConvexError(error: unknown): ConvexError<{
  code: string;
  message: string;
}> {
  if (error instanceof NotAdminError) {
    return new ConvexError({ code: "NOT_FOUND", message: "Not found" });
  }
  if (error instanceof AppSecretError) {
    return new ConvexError({ code: "INVALID_SECRET", message: error.message });
  }
  throw error;
}
