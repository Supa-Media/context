import type { ReactMutation } from "convex/react";
import type { useAuthActions } from "@convex-dev/auth/react";
import type { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { forgetContextCopies, forgetLocalCopies } from "../../offline/forget";
import { resetObservabilityUser } from "../../observability/client";

/**
 * The two account-level moves the live console offers, built for one render
 * from the handles `useLiveConsoleData` holds. Moved out of that hook's
 * returned object verbatim; it spreads this back in at the same place.
 */
export function accountActionsFor({
  leaveWorkspace,
  deleteAccountMutation,
  authActions,
}: {
  leaveWorkspace: ReactMutation<typeof api.functions.workspaces.leaveWorkspace>;
  deleteAccountMutation: ReactMutation<typeof api.functions.account.deleteAccount>;
  authActions: ReturnType<typeof useAuthActions> | undefined;
}) {
  return {
    // Walking out of somebody else's context is the member's own move — the
    // server refuses it for owners (`OWNER_CANNOT_LEAVE`), so the rail only
    // offers it on a row whose role is not `owner`. The subscription drops it from
    // `contexts` on its own once the membership row is gone.
    // What is cached for a context you have left is a copy of somewhere you can
    // no longer reach — notes somebody shared with you, held on your machine
    // after the membership that justified holding them is gone. It is cleared
    // **on the server's answer, never on the request**: `leaveWorkspace`
    // returns `{ left: false }` for a membership row it did not find — already
    // left in another tab, or removed by the owner while this console was open
    // — and clearing on the press would throw away the offline copy of a
    // context the person still has.
    //
    // An owner is a *third* case: `leaveWorkspace` throws `OWNER_CANNOT_LEAVE`
    // rather than answering `{ left: false }`, so nothing below the `await`
    // runs at all. Same outcome, different path — and the rejection reaches the
    // rail's `void data.leaveContext?.(id)`, which has nowhere to put it. That
    // is pre-existing and is not what this line is about.
    leaveContext: async (id: string) => {
      const result = await leaveWorkspace({ workspaceId: id as Id<"workspaces"> });
      if (result.left) await forgetContextCopies(id);
      return result;
    },
    // Everything on the control plane goes; the person's own storage is not
    // ours to touch. The local sign-out afterwards clears the tokens for a
    // session whose server rows the mutation just deleted — its own signOut
    // call failing server-side is expected and swallowed by the auth client.
    deleteAccount: async () => {
      await deleteAccountMutation({});
      // After the deletion, and before the sign-out. After, because a deletion
      // that failed must not cost somebody the queue it never sent; before,
      // because the browser must not still be holding readable note text once
      // the session it belonged to is over. `forget.ts` owns the failure
      // stance — it can report, and it can never block this.
      await forgetLocalCopies();
      await authActions?.signOut();
      resetObservabilityUser();
    },
  };
}
