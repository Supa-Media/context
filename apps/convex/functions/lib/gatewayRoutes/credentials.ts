/**
 * `POST /gateway/binding`: the gateway route that hands back a decrypted
 * storage credential, spending both proofs — the gateway secret (checked by
 * the factory) and the user's access token.
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
    // Search by meaning's index, same terms as `searchIndex`: absent unless
    // the workspace's index exists and takes writes.
    meaningIndex: opened.meaningIndex,
    encryptionKey: opened.encryptionKey,
    // Fourth sibling, same terms: absent unless a rotation is in progress,
    // which is every context that has never rotated (all of them, before
    // this shipped) and every one whose last rotation finished.
    rotation: opened.rotation,
    // Fifth, same terms: absent for every context not on the free managed
    // tier. The gateway refuses a new note past it — `store/noteCap.js`.
    noteCap: opened.noteCap,
    // Sixth: `{mode}` while a managed bucket is being or has been encrypted,
    // absent otherwise. A gateway that gets a mode and no usable key refuses
    // the store rather than serving sealed bytes — `store/managedEncryption.js`.
    managedEncryption: opened.managedEncryption,
  });
}
