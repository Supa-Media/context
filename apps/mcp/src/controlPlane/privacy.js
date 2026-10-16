/**
 * The privacy authority, from the gateway's side (phase 3 of
 * `docs/decisions/app-and-console/convex-tree.md`): what the store that
 * writes `privacy.md` (`store/privacyAuthority.js`) asks of the control plane.
 *
 * Every call spends the person's token, as `/gateway/binding` does (or, for a
 * queued move, its job ticket), and names the workspace only for the control
 * plane to compare with the one that proof reaches. The rules travel as names and visibilities, never as note text.
 */

import { ControlPlaneError } from "./client.js";

const rulesOf = (change) => ({
  folders: change.folders.map((rule) => ({ prefix: rule.prefix, visibility: rule.visibility })),
  notes: change.notes.map((rule) => ({ path: rule.path, visibility: rule.visibility })),
});

export function createPrivacyMethods({ post }) {
  return {
    /**
     * The authority one request's store writes through, given the rules the
     * binding carried (`null` while `privacy.md` is the authority).
     *
     * @param {{accessToken: string}|{ticket: string}} proof exactly one of the two
     * @param {string} expectedWorkspaceId
     * @returns {import("../store/privacyAuthority.js").PrivacyAuthority}
     */
    privacyAuthority(proof, expectedWorkspaceId, rules) {
      const credential =
        typeof proof?.accessToken === "string" ? { accessToken: proof.accessToken } : { ticket: proof?.ticket };
      const send = async (op, body) => {
        const answer = await post("/gateway/privacy", { ...credential, expectedWorkspaceId, op, ...body });
        if (answer?.ok !== true) throw new ControlPlaneError("privacy refused");
        return answer;
      };
      return {
        rules: rules ?? null,
        async write(change) {
          const answer = await send("write", { expected: change.expected, ...rulesOf(change) });
          return answer.swapped ?? null;
        },
        async written(change) {
          await send("written", { previous: change.previous, etag: change.etag, ...rulesOf(change) });
        },
        async exported(done) {
          await send("exported", { rendered: done.rendered, etag: done.etag });
        },
        async owed() {
          await send("owed", {});
        },
        /**
         * Rows mode: one row's base, from the version the gateway holds. Answers the
         * control plane's own answer (`{ok, version}` or `{ok: false, code}`) rather
         * than throwing, so the caller can map CONFLICT and FORBIDDEN to its own errors.
         * A tier replaces the row's list, as a file override did: `grantees: []` says so.
         */
        async setAccess(change) {
          const body = { path: change.path, base: change.base, grantees: [] };
          if (typeof change.expectedVersion === "number") body.expectedVersion = change.expectedVersion;
          return await post("/gateway/privacy", { ...credential, expectedWorkspaceId, op: "setAccess", ...body });
        },
      };
    },
  };
}
