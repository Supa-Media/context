/**
 * No credential the gateway holds survives being spread, stringified, or
 * enumerated.
 *
 * Three objects carry a secret through a request: the resolved session and its
 * cross-context sibling each hold the caller's OAuth access token, and the
 * store holds the D1 write token that came with the storage binding. All three
 * are attached with `Object.defineProperty(..., { enumerable: false })`, and
 * The rule is argued at length where it is written down — "the single most
 * likely way for a bearer token to reach a log line", "one `{...store}` or one
 * `JSON.stringify` away from a D1 write token" — the sibling session's half in
 * `sessionForContext`'s own header rather than at the property.
 *
 * ## Why this file exists
 *
 * **All three of those guards were proved by nothing.** Measured by flipping
 * each `enumerable: false` to `true` in turn and running the suite: 0, 0, 0,
 * ALL PASS every time. The argument was written down three times and checked
 * zero. With this file each flip reddens.
 *
 * The mutant is live in every case — `enumerable` is exactly what `Object.keys`,
 * the spread and `JSON.stringify` read — so these zeros were a missing proof
 * and not an unobservable edit.
 *
 * Nothing in the gateway spreads or stringifies a session or a store *today*;
 * `{ ...session }` in `meetings/` is a meeting record, a different object. That
 * is the point rather than a reason to skip it: this is a guard against a log
 * line somebody adds next year, which is exactly the kind that rots unobserved.
 * The property is asserted on the real functions — `resolveSession`,
 * `sessionForContext`, `storeForSession` — so it holds for whatever those
 * return, not for a hand-built copy of what they returned when this was written.
 */

import { resolveSession, sessionForContext, storeForSession } from "../src/session.js";
import { readSearchIndexBinding } from "../src/search/d1/client.js";
import { storeForBinding } from "../src/store/factory.js";

const TOKEN = `cat_shape_${"0".repeat(30)}`;
const API_TOKEN = "d1-write-token-not-a-real-one";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const DROPBOX_TOKEN = "sl.dropbox-access-token-not-a-real-one";

const BINDING = Object.freeze({
  provider: "s3",
  status: "active",
  workspaceId: "ws_home",
  endpoint: "https://s3.example-credential-shape.test",
  region: "auto",
  bucket: "example-bucket",
  rootPrefix: "context/",
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: SECRET_KEY,
  forcePathStyle: true,
  capabilities: { conditionalWrite: true },
  searchIndex: {
    databaseId: "d1-database-id",
    accountId: "cloudflare-account-id",
    apiToken: API_TOKEN,
    state: "backfilling",
  },
});

const controlPlane = {
  async resolveSession() {
    return {
      grantId: "grant_shape",
      clientId: "client_shape",
      actorUserId: "user_shape",
      scopes: ["context:read", "context:write", "context:private"],
      defaultWorkspaceId: "ws_home",
      workspaces: [
        { workspaceId: "ws_home", slug: "home", role: "owner" },
        { workspaceId: "ws_other", slug: "other", role: "member" },
      ],
    };
  },
  async getStorageBinding() {
    return BINDING;
  },
};

/*
  The channels that read enumerability. Not four independent probes — they are
  four readings of one bit, which is the bit the guard sets — but each is a
  shape somebody actually writes, and a check named after `JSON.stringify`
  should fail when `JSON.stringify` is the thing that changed.
*/
function exposedKeys(object) {
  return [
    ...Object.keys(object),
    ...Object.keys({ ...object }),
    ...Object.keys(JSON.parse(JSON.stringify(object))),
    ...Object.entries(object).map(([key]) => key),
  ];
}

/** The secret text itself, through the same three channels. */
function exposedText(object) {
  return [JSON.stringify(object), JSON.stringify({ ...object }), Object.entries(object).join("|")]
    .join("\n");
}

export async function runCredentialShapeChecks(check) {
  const session = await resolveSession(TOKEN, null, controlPlane);

  check("a resolved session still carries its token by name", session.accessToken === TOKEN);
  check(
    "but the token is not one of the session's own keys",
    !exposedKeys(session).includes("accessToken")
  );
  check("so no spread or stringify of it carries the token", !exposedText(session).includes(TOKEN));

  const sibling = sessionForContext(session, "@other");
  check("a cross-context sibling still carries the token by name", sibling.accessToken === TOKEN);
  check(
    "and does not expose it either — it is re-attached, never spread",
    !exposedKeys(sibling).includes("accessToken") && !exposedText(sibling).includes(TOKEN)
  );

  const store = await storeForSession(session, {}, controlPlane);

  check("the store carries its index credential by name", store.searchIndex?.apiToken === API_TOKEN);
  check(
    "but the index descriptor is not one of the store's own keys",
    !exposedKeys(store).includes("searchIndex")
  );
  check(
    "so no spread or stringify of the store carries the D1 write token",
    !exposedText(store).includes(API_TOKEN)
  );
  /*
    THE BUCKET CREDENTIAL IS THE OLDER HALF OF THE SAME RULE AND HAD NO GUARD.

    `session.js` argues the D1 token is "radioactive on exactly the terms
    `secretAccessKey` is" — and `secretAccessKey` was an ordinary enumerable
    property, so `JSON.stringify(store)` emitted a customer's bucket secret in
    full while the token beside it was carefully hidden. `S3Store`'s own
    constructor says of it: "never logged, never written to the bucket, never
    placed in a URL." Dropbox's access token was the same.

    Nothing in the gateway stringifies or spreads a store today — `{ ...session }`
    in `meetings/` is a meeting record — so this was latent rather than leaking.
    That is what the guard is for: the log line somebody adds next year.

    Asserted on what the store LOOKS like rather than on how it is built, so it
    survives a rewrite of either adapter.
  */
  /*
    PAIRED, because the negative alone is vacuous. Every other check here has a
    positive twin asserting the credential is still reachable by name, and this
    one did not: an `S3Store` that stored the WRONG secret passed the whole
    suite, so "the secret is not on the store" would have gone green on a store
    that had lost it. Review caught it; the twin is the fix, and it also closes
    a gap older than this file — nothing proved the S3 store carries the
    credential it was built with.
  */
  check("the store carries its bucket secret by name", store.secretAccessKey === SECRET_KEY);
  check(
    "and the bucket secret is not on the store either",
    !exposedText(store).includes(SECRET_KEY)
  );

  const dropboxStore = storeForBinding(
    {
      provider: "dropbox",
      status: "active",
      workspaceId: "ws_home",
      accessToken: DROPBOX_TOKEN,
      rootPrefix: "/context",
      capabilities: { conditionalWrite: true },
    },
    {}
  );
  check(
    "a Dropbox store still holds its token by name",
    dropboxStore.accessToken === DROPBOX_TOKEN
  );
  check(
    "but does not carry it out through a spread or a stringify either",
    !exposedKeys(dropboxStore).includes("accessToken") &&
      !exposedText(dropboxStore).includes(DROPBOX_TOKEN)
  );

  /*
    A partial descriptor is off, not half-configured — one check per field.

    `readSearchIndexBinding` refuses on three fields and the suite proved ONE of
    them: deleting the `databaseId` check reddened nothing and so did deleting
    the `accountId` check, while the `apiToken` one reddened 1. Three sibling
    lines differing only in the field they name, one watched. What the two
    unwatched ones stand between is a request built from `undefined` — a POST to
    `/accounts/undefined/d1/database/<id>/query`, or to `.../database/undefined/`
    — carrying the account-wide D1 write token in its `Authorization` header.
    Reaching a database with two of its three coordinates is not a thing to
    attempt, and now nothing may quietly start.

    The empty string is here because the checks read `!value` as well as the
    type, and an empty `accountId` builds the same `undefined`-shaped URL.
  */
  const complete = { ...BINDING.searchIndex };
  for (const field of ["databaseId", "accountId", "apiToken"]) {
    check(
      `a descriptor with no ${field} is off, not half-configured`,
      readSearchIndexBinding({ searchIndex: { ...complete, [field]: undefined } }) === null
    );
    check(
      `and an empty ${field} is off too, not a URL built from nothing`,
      readSearchIndexBinding({ searchIndex: { ...complete, [field]: "" } }) === null
    );
    check(
      `and a non-string ${field} is off as well`,
      readSearchIndexBinding({ searchIndex: { ...complete, [field]: 12 } }) === null
    );
  }
  const read = readSearchIndexBinding({ searchIndex: complete });
  check(
    "while a complete descriptor is read whole, all three coordinates",
    read.databaseId === complete.databaseId &&
      read.accountId === complete.accountId &&
      read.apiToken === complete.apiToken
  );
}
