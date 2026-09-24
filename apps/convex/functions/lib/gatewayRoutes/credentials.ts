/**
 * `POST /gateway/binding` and `POST /gateway/provider`: the two gateway routes
 * that hand back a decrypted credential, each spending both proofs — the
 * gateway secret (checked by the factory) and the user's access token.
 *
 * Split out of `http.ts`, which keeps every route declared and registered
 * under the same name and path, built by the same factory, and passes these
 * handlers to it; this module registers nothing. The factory's secret check
 * still runs before any of this code.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, nullableStringField, stringField } from "../gatewayAuth";

/**
 * THE TWO-FACTOR ROUTE. Read `controlPlane.js` before changing anything here.
 *
 * `accessToken` is the authority; `expectedWorkspaceId` is not. The workspace
 * is derived from the grant the token resolves to, inside
 * `openStorageBinding`, and the expected id is compared against it and used
 * for nothing else. There is no path in which it selects a row.
 *
 * This is the one route whose response contains a decrypted secret. It is
 * fetched per request and never cached, on either side.
 *
 * ## The optional `searchIndex` sibling
 *
 * Present only where this workspace has an opted-in, provisioned fast-search
 * index; **absent is the normal case and is not an error**. It carries a D1
 * database id, an account id and a write token, because the gateway is the only
 * component that reads note text and therefore the only one that can project it.
 * It is a sibling of `binding` rather than a route of its own precisely so it
 * spends the same two proofs — a second route handing out a credential would be
 * a third entry in `CREDENTIAL_HTTP_ROUTES`, which that comment says is a
 * conversation.
 *
 * The workspace it describes is the one the *grant* resolved to, exactly like
 * the binding beside it. There is no shape of this request that names whose
 * index comes back.
 */
export async function gatewayBindingHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  // A malformed request is answered exactly like an unknown token. There is
  // nothing here worth distinguishing, and a 400 would tell a caller holding
  // the gateway secret which of its two proofs was the bad one.
  if (accessToken === null || !expected.ok) return json({ binding: null });

  // Both optional, both absent on every ordinary request. `rotate_encryption_keys`
  // is the only tool that ever sets either, and it does so only for a grant
  // the gateway has already checked is owner-scoped — the same discipline
  // `set_encryption` uses. A malformed value here is treated as absent rather
  // than a 400, for the same reason the two fields above are: this route
  // never distinguishes a bad request from an ordinary one.
  const startEncryptionRotation = body?.startEncryptionRotation === true;
  const completeEncryptionRotation =
    typeof body?.completeEncryptionRotation === "string" && body.completeEncryptionRotation.length > 0
      ? body.completeEncryptionRotation
      : undefined;

  const opened = await ctx.runAction(
    internal.functions.controlPlane.openStorageBinding,
    {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected.value,
      startEncryptionRotation,
      completeEncryptionRotation,
    },
  );
  if (opened === null) return json({ binding: null });
  // `searchIndex` is `undefined` for every context that has no usable index,
  // and `JSON.stringify` drops an undefined value — so the normal case is the
  // key being **absent**, not present and null. A gateway on an older build
  // reads the same bytes it always did.
  //
  // `encryptionKey` is a third sibling on exactly the same terms: absent for
  // every context that has never encrypted a note, which is all of them until
  // an owner turns it on, and absent again for a key this deployment could not
  // open. A gateway that does not know the field ignores it; one that does
  // treats its absence as "cannot decrypt", which shows a locked note rather
  // than a missing one.
  return json({
    binding: opened.binding,
    searchIndex: opened.searchIndex,
    encryptionKey: opened.encryptionKey,
    // Fourth sibling, same terms: absent unless a rotation is in progress,
    // which is every context that has never rotated (all of them, before
    // this shipped) and every one whose last rotation finished.
    rotation: opened.rotation,
  });
}

/**
 * Open one workspace's own Anthropic or OpenAI key for the gateway.
 *
 * ## Why this is a route and not a fifth sibling on `/gateway/binding`
 *
 * Every gateway-facing credential added since `binding` became a sibling of it
 * — `searchIndex`, `encryptionKey`, `rotation` — precisely so that
 * `CREDENTIAL_HTTP_ROUTES` would not grow, and the comment above says adding to
 * that set is a conversation. This is the conversation, and it comes out the
 * other way for one reason.
 *
 * #661 was a **returns validator** accident: `v.object` is exact, a field
 * drifted, the error named the object it had refused, and `s3BindingValidator`
 * carries `secretAccessKey`. Everything folded into `openStorageBinding`'s
 * return shares that fate — one drift anywhere in it spills everything in it.
 * A model key folded in would make that error able to spill a storage secret
 * *and* somebody's provider account in one line.
 *
 * So the model key gets a validator of its own, two flat fields wide, with
 * nothing nested to drift. That is a smaller blast radius than the sibling,
 * and it is bought with a door that is the same door: the same `gatewayRoute`
 * factory, the same gateway secret, the same access token, the same
 * `expectedWorkspaceId`-is-compared-never-looked-up rule in
 * `providers.openProviderForGateway`, and `null` for everything that is not a
 * hit.
 *
 * It buys one more thing. An ordinary MCP request spends `/gateway/binding` on
 * every call; a model key riding that payload would be decrypted on every
 * `list_notes` in the product. Here it is opened only by the request that is
 * about to spend it.
 *
 * ## What this route decides, which is nothing
 *
 * It shapes the body and hands the two proofs on. The provider string is passed
 * through *unvalidated* on purpose: the closed set lives in `providers.ts`, and
 * checking it there means an unknown provider is the same `null` as an unknown
 * token rather than a different status a caller could count.
 */
export async function gatewayProviderHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = nullableStringField(body, "expectedWorkspaceId");
  const provider = stringField(body, "provider");
  // A malformed request is answered exactly like an unknown token, for the
  // reason `/gateway/binding` gives: a 400 would tell a caller holding the
  // gateway secret which of its proofs was the bad one.
  if (accessToken === null || !expected.ok || provider === null) {
    return json({ credential: null });
  }

  const credential = await ctx.runAction(
    internal.functions.providers.openProviderForGateway,
    {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: expected.value,
      provider,
    },
  );

  // `credential` is the whole answer. Nothing rides beside it — not the
  // workspace it came from, not the fingerprint, not the grant. See the
  // `a hit names the provider and the key, and nothing else` test.
  return json({ credential });
}
