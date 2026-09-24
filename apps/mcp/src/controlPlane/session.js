/**
 * Session and binding resolution: turning a presented access token into a
 * session, a storage binding, or a model provider credential.
 */
import { ControlPlaneError } from "./client.js";

export function createSessionMethods({ post, required }) {
  return {
    /**
     * @param {string} accessToken the bearer token exactly as presented
     * @returns {Promise<object|null>} the session, or null for no live grant.
     */
    async resolveSession(accessToken) {
      return required(await post("/gateway/session", { accessToken }), "session");
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
      });
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
        encryptionKey: parsed.encryptionKey ?? null,
        rotation: parsed.rotation ?? null,
      };
    },

    /**
     * Fetch the model account for the workspace **the user's token names**.
     *
     * A route of its own rather than a fifth sibling on `/gateway/binding`, and
     * `apps/convex/http.ts`'s own header for `/gateway/provider` carries the
     * argument: folding a model key into `openStorageBinding`'s return would
     * put it inside the same `v.object` as `secretAccessKey`, where #661 showed
     * that one drifted field serializes everything beside it into a log. Two
     * flat fields behind their own door is the smaller blast radius, and the
     * door spends the identical two proofs this file's contract already
     * describes — the gateway secret, and the user's access token, with
     * `expectedWorkspaceId` selecting inside the token's own set and never
     * outside it.
     *
     * It also means the key is opened only by the request about to spend it,
     * rather than decrypted on every `list_notes` in the product.
     *
     * `credential` keeps `required`'s null-vs-missing discipline: an explicit
     * `null` is "nothing connected, or nothing you may reach", and a *missing*
     * key is a control plane answering some other contract, which must not be
     * read as "no credential" — for the reason `required` gives.
     *
     * @param {string} accessToken the bearer token exactly as presented
     * @param {string|null} expectedWorkspaceId the gateway's own conclusion
     * @param {string} provider "anthropic" or "openai"; the closed set is the
     *   control plane's, and an unknown one comes back `null` rather than as a
     *   distinguishable error
     * @returns {Promise<{provider: string, apiKey: string}|null>}
     */
    async getProviderCredential(accessToken, expectedWorkspaceId, provider) {
      const parsed = await post("/gateway/provider", {
        accessToken,
        expectedWorkspaceId,
        provider,
      });
      return required(parsed, "credential");
    },
  };
}
