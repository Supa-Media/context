/**
 * The access rules, from the gateway's side: what the store that serves them
 * (`store/privacyAuthority.js`) asks of the control plane.
 *
 * Every call spends the person's token, as `/gateway/binding` does (or, for a
 * queued move, its job ticket), and names the workspace only for the control
 * plane to compare with the one that proof reaches. The rules travel as names and visibilities, never as note text.
 */

import { ControlPlaneError } from "./client.js";

export function createPrivacyMethods({ post }) {
  return {
    /**
     * The access rules one request's store serves, and the calls it makes to change a row.
     *
     * @param {{accessToken: string}|{ticket: string}} proof exactly one of the two
     * @param {string} expectedWorkspaceId
     * @param {object} rules the rules the binding carried, as the control plane renders them for this reader
     * @returns {import("../store/privacyAuthority.js").PrivacyAuthority}
     */
    privacyAuthority(proof, expectedWorkspaceId, rules) {
      const credential =
        typeof proof?.accessToken === "string" ? { accessToken: proof.accessToken } : { ticket: proof?.ticket };
      return {
        rules,
        /**
         * One row's base, from the version the gateway holds. Answers the control plane's own answer
         * (`{ok, version}` or `{ok: false, code}`) rather than throwing, so the caller can map CONFLICT and FORBIDDEN
         * to its own errors. A tier names no `grantees`, so the owner's list is kept: a list is sent only when the caller
         * gives one (`[]` clears it). Sending `[]` for a tier would wipe the people the owner named.
         */
        async setAccess(change) {
          const body = { path: change.path, base: change.base };
          if (Array.isArray(change.grantees)) body.grantees = change.grantees;
          if (typeof change.expectedVersion === "number") body.expectedVersion = change.expectedVersion;
          // Said only for a folder: a path with no row takes its pending access as the row it is for (`pendingAccess.ts`).
          if (change.kind === "folder") body.kind = "folder";
          return await post("/gateway/privacy", { ...credential, expectedWorkspaceId, op: "setAccess", ...body });
        },
        /**
         * People added to one row's list (`set_visibility`'s `people`), each `{handle|email, role}`.
         * Adds, never replaces; owner only. Answers the control plane's own answer, as `setAccess` does.
         */
        async addGrantees(change) {
          return await post("/gateway/privacy", {
            ...credential,
            expectedWorkspaceId,
            op: "addGrantees",
            path: change.path,
            entries: change.entries,
          });
        },
      };
    },
  };
}
