/**
 * Session and binding resolution: turning a presented access token into a
 * session or a storage binding, and asking whether a turn may spend the
 * built-in model.
 */
import { CONTROL_PLANE_MOVE_BATCH_TIMEOUT_MS, CONTROL_PLANE_SITE_TIMEOUT_MS, ControlPlaneError } from "./client.js";
import { TREE_RESPONSE_BYTE_CAP } from "./tree.js";

export function createSessionMethods({ post, required }) {
  return {
    /**
     * @param {string} accessToken the bearer token exactly as presented
     * @param {{kind: "path", route: string} | {kind: "header"} | null} [transport]
     *   how it came; only the path form is sent, with its route's coarse name.
     * @returns {Promise<object|null>} the session, or null for no live grant.
     */
    async resolveSession(accessToken, transport = null) {
      const pathRoute = transport?.kind === "path" ? { transport: "path", route: transport.route } : {};
      return required(await post("/gateway/session", { accessToken, ...pathRoute }), "session");
    },

    /** Re-authorize the bounded set of grants currently seated in one room. */
    async resolveGrantSessions(expectedWorkspaceId, grantIds) {
      const sessions = required(
        await post("/gateway/sessions/by-grant", { expectedWorkspaceId, grantIds }),
        "sessions"
      );
      if (!Array.isArray(sessions) || sessions.length !== grantIds.length) {
        throw new ControlPlaneError("malformed grant sessions");
      }
      return sessions;
    },

    /**
     * Fetch the storage binding for the workspace **the user's token names**.
     *
     * `expectedWorkspaceId` is the gateway's own independent conclusion, sent
     * so the control plane can refuse a mismatch. It is not a lookup key and
     * the control plane must not treat it as one — see the contract above.
     *
     * ## The response is TWO things, and reading one of them was the whole bug
     *
     * `/gateway/binding` answers `{binding, searchIndex}` — **siblings**, and
     * `http.ts` says so: "the storage binding, and — only where an owner asked
     * for one and it exists — the index credential BESIDE it". That shape is
     * deliberate: a D1 write credential is not a property of a bucket, and
     * nesting it inside the binding would mean adding it to both provider
     * validators and handing it to `storeForBinding`, which has no business
     * with it.
     *
     * This returned `parsed.binding` alone, and `session.js` then looked for
     * the descriptor at `binding.searchIndex` — a key the control plane has
     * never sent. So `store.searchIndex` was `null` on every request in
     * production, `fastSearchAnswer` returned on its first line, and fast
     * search served **not one search** between the reader shipping and this
     * being found. Both sides' contract comments described their own shape
     * correctly and neither described the other's, which is exactly why no
     * test caught it: the gateway's fixtures were written from the gateway's
     * assumption.
     *
     * So the envelope is returned whole. `binding` keeps `required`'s
     * null-vs-missing discipline — a missing key is a version skew and throws.
     * `searchIndex` is read with `??`, because ABSENT IS THE NORMAL CASE: it is
     * `undefined` for every context that never opted in, `JSON.stringify` drops
     * it, and demanding it would refuse every binding in the product.
     *
     * `rotation` is a fourth sibling on the same request. `rotate_encryption_keys`
     * passes `{start: true}` to mint (or continue) a workspace-key rotation, or
     * `{complete: "<generation>"}` to report a bucket-side walk finished —
     * both spend the same two proofs this call already carries rather than a
     * separate route, exactly as `searchIndex` and `encryptionKey` do. Every
     * other caller passes nothing, and the control plane still reports whether
     * a rotation is outstanding, because starting one is optional but knowing
     * about one is not.
     *
     * @param {{start?: true, complete?: string}} [rotationRequest]
     * @returns {Promise<{binding: object|null, searchIndex: object|null, encryptionKey: object|null, rotation: object|null}>}
     */
    async getStorageBinding(accessToken, expectedWorkspaceId, rotationRequest) {
      const parsed = await post("/gateway/binding", {
        accessToken,
        expectedWorkspaceId,
        ...(rotationRequest?.start === true ? { startEncryptionRotation: true } : {}),
        ...(typeof rotationRequest?.complete === "string"
          ? { completeEncryptionRotation: rotationRequest.complete }
          : {}),
        // The tree's cap, for the tree's reason: the answer carries the workspace's access rules, one line per
        // note with its own (`nodesPrivacy.ts` heldFor), so the 256 KB every other answer is held to refused
        // every request to a workspace past a few thousand such notes (@supa, 2026-10-29: group Tex dark).
      }, { maxBytes: TREE_RESPONSE_BYTE_CAP });
      // Four siblings on the response, not one shape with the other three
      // nested inside it. `binding` is required; `searchIndex`, `encryptionKey`
      // and `rotation` are absent in the ordinary case — no index opted in, no
      // note ever encrypted, no rotation ever started — and absent again when
      // the control plane could not open or resolve one. Reading any of them
      // out of the binding instead of off the response is the bug that left
      // fast search dead in production for a year, so all four are read here,
      // beside each other, where the shape is visible.
      return {
        binding: required(parsed, "binding"),
        searchIndex: parsed.searchIndex ?? null,
        // Search by meaning's index, `searchIndex`'s terms: absent until it takes writes.
        meaningIndex: parsed.meaningIndex ?? null,
        encryptionKey: parsed.encryptionKey ?? null,
        rotation: parsed.rotation ?? null,
        // The free managed tier's note cap, a fifth sibling and absent for
        // every context without one. Only a positive integer means a cap.
        noteCap: Number.isInteger(parsed.noteCap) && parsed.noteCap > 0 ? parsed.noteCap : null,
        // Managed-storage encryption, a sixth sibling: `{mode}` for a managed
        // bucket being encrypted or already encrypted, absent otherwise.
        managedEncryption: parsed.managedEncryption ?? null,
        // An eighth sibling: the access rules the rows render for this reader (`store/privacyAuthority.js`).
        privacy: parsed.privacy ?? null,
        // `"keys"`: notes live only at their id keys (`store/idLayout.js`). Every
        // workspace is keyed; anything else is a control plane that cannot say
        // where notes are, and the session store refuses it.
        idLayout: parsed.idLayout === "keys" ? "keys" : null,
        // The staff console's feature switches (`functions/featureSwitches.ts`):
        // only a literal `true` turns one on, so a missing or odd value is off.
        features: { vaultKeyUse: parsed.features?.vaultKeyUse === true },
      };
    },

    /**
     * Ask the control plane to queue a folder move (phase 4 of the Convex
     * tree): the tree draws it at once and the bucket catches up behind it.
     * The same two proofs as every route; the workspace is the grant's, and
     * whether the caller may move anything there is decided there again.
     *
     * @returns {Promise<{queued: true, count: number}|{queued: false}|{queued: false, error: string, message: string}>}
     */
    async startQueuedMove(accessToken, expectedWorkspaceId, from, to, expectedEtag) {
      const body = { accessToken, expectedWorkspaceId, from, to };
      // A note asked against the version the caller read; absent for a folder or an online press.
      if (typeof expectedEtag === "string") body.expectedEtag = expectedEtag;
      return required(await post("/gateway/moves/start", body), "move");
    },

    /**
     * Ask the control plane to make several note moves in a keyed workspace,
     * whole or not at all (`/gateway/moves/batch`). The same proofs as
     * `startQueuedMove`. Each move may carry the version the caller read.
     *
     * @param {{from: string, to: string, expectedEtag?: string}[]} moves
     * @returns {Promise<{ok: true, moves: {from: string, to: string}[]}|{ok: false, error: string, message: string}>}
     */
    async startMoveBatch(accessToken, expectedWorkspaceId, moves) {
      return required(
        // The control plane moves every row before it answers: longer than a lookup.
        await post("/gateway/moves/batch", { accessToken, expectedWorkspaceId, moves }, { timeoutMs: CONTROL_PLANE_MOVE_BATCH_TIMEOUT_MS }),
        "move"
      );
    },

    /**
     * Ask the control plane to move a note or folder into another workspace
     * the grant reaches (`/gateway/moves/across`), with the engine the
     * console's Move uses: the only way a keyed note crosses. The same proofs
     * as `startQueuedMove`; both workspaces' roles are checked there.
     *
     * @returns {Promise<{status: "complete"|"failed"|"moving", movedObjects: number, skipped: {path: string, reason: string}[], error?: string}|null>}
     */
    async moveAcross(accessToken, sourceWorkspaceId, destinationWorkspaceId, from, to) {
      return required(
        // The engine carries the note before it answers: longer than a lookup.
        await post(
          "/gateway/moves/across",
          { accessToken, sourceWorkspaceId, destinationWorkspaceId, from, to },
          { timeoutMs: CONTROL_PLANE_SITE_TIMEOUT_MS }
        ),
        "move"
      );
    },

    /**
     * May this turn spend the built-in model? The control plane decides and
     * counts the turn (`apps/convex/functions/builtinModel.ts`); `null` is an
     * unknown token or a workspace the token cannot reach.
     *
     * @returns {Promise<{allowed: true, remaining: number}|{allowed: false, reason: string}|null>}
     */
    async startBuiltinTurn(accessToken, expectedWorkspaceId, { tryIt = false } = {}) {
      // `tryIt` only from the AI tab's Try it route (`agent/tryIt.js`): the control plane checks the person may.
      const parsed = await post("/gateway/builtin-model", { accessToken, expectedWorkspaceId, ...(tryIt ? { tryIt: true } : {}) });
      return required(parsed, "verdict");
    },

    /**
     * May this grant spend one meeting summary? Every plan may, under a daily
     * ceiling that depends on the plan (`apps/convex/functions/meetingSummary.ts`),
     * and the answer counts the summary. `null` is an unknown token or a
     * workspace it cannot reach.
     *
     * @returns {Promise<{allowed: true, remaining: number, paying: boolean}|{allowed: false, reason: string, paying: boolean}|null>}
     */
    async startMeetingSummary(accessToken, expectedWorkspaceId) {
      const parsed = await post("/gateway/meeting-summary", { accessToken, expectedWorkspaceId });
      return required(parsed, "verdict");
    },

    /** What one meeting summary spent: token counts, the model and a duration, never text. */
    async recordMeetingSummaryUsage(
      accessToken,
      expectedWorkspaceId,
      { input, output, cacheRead = 0, cacheWrite = 0, model, failed, ms },
    ) {
      await post("/gateway/meeting-summary/usage", {
        accessToken,
        expectedWorkspaceId,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        model,
        failed,
        ms,
      });
    },

    /**
     * One finished agent turn for the turn log (`apps/convex/functions/agentTurns.ts`):
     * provider, model, outcome, durations, token counts and the trace of
     * model rounds and tool names. Never text, never a tool's arguments.
     */
    async recordAgentTurn(accessToken, expectedWorkspaceId, turn) {
      await post("/gateway/agent-turn", { accessToken, expectedWorkspaceId, ...turn });
    },

    /**
     * What a finished built-in turn spent: token counts, the model that answered
     * (for its price) and a duration, never text. Cache counts default to zero.
     */
    async recordBuiltinUsage(
      accessToken,
      expectedWorkspaceId,
      { input, output, cacheRead = 0, cacheWrite = 0, model, decision = 0, failed, ms, tryIt = false },
    ) {
      await post("/gateway/builtin-model/usage", {
        ...(tryIt ? { tryIt: true } : {}),
        accessToken,
        expectedWorkspaceId,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        model,
        decisionTokens: decision,
        failed,
        ms,
      });
    },
  };
}
