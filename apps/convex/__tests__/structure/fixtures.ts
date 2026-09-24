/// <reference types="vite/client" />
/**
 * Shared analyzer, constants and fixtures for the credential-reachability
 * suite. Split out of the original `structure.test.ts` (which was 3,147
 * lines) purely by responsibility; the tests themselves live beside this
 * file in `__tests__/structure/`. Nothing here is executed as a test in its
 * own right -- see `reachability.test.ts`, `scheduling.test.ts`,
 * `barriers.test.ts` and `httpRoutes.test.ts`.
 *
 * The header comment below is preserved verbatim from the original file
 * because it explains what this whole suite defends, not just this module.
 */
/**
 * THE CREDENTIAL BOUNDARY, ENFORCED STRUCTURALLY.
 *
 * `SECURITY.md` commitment #2 says storage secrets are "decryptable only by
 * internal server code paths — never returned by any client-callable
 * function". This file is what makes that a property of the codebase rather
 * than a habit.
 *
 * ## What the previous guard was, and how it fell over
 *
 * It enumerated the exports of `functions/storage.ts` and asserted that no
 * *public* one had `secret`, `credential`, or `decrypt` in its **name**. Two
 * holes, and an adversarial review walked through both at once by adding a new
 * file:
 *
 * ```ts
 * // functions/gateway.ts
 * export const fetchBucketConfig = action({
 *   args: { workspaceId: v.id("workspaces") },
 *   handler: async (ctx, args) =>
 *     await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
 * });
 * ```
 *
 * An unauthenticated caller got a decrypted secret and the whole suite stayed
 * green: the loop never looked outside one file, and `fetchBucketConfig`
 * contains none of the three words. A guard a rename defeats is not a guard,
 * and a guard scoped to the file you already trust is not a guard either.
 *
 * ## What this asserts instead
 *
 * It walks **every** Convex module, classifies each exported function by what
 * Convex itself says it is (`isPublic` / `isInternal` — not by its name), and
 * builds the call graph from `ctx.runQuery/runMutation/runAction(internal.…)`
 * references. Then: **no public function may transitively reach the decrypt
 * path.** Rename anything you like; add any file you like; the reachability is
 * what fails.
 *
 * Two supporting rules make that closure honest:
 *
 *  - **No dynamic dispatch.** A `ctx.runAction(someComputedRef)` cannot be
 *    followed statically, so it is refused outright rather than assumed safe.
 *    Otherwise `ctx.runAction((internal as any).functions.storage[name])`
 *    walks straight through the graph.
 *  - **Fail closed on helpers.** If a module reaches `decryptSecret` from
 *    somewhere other than inside a single exported function's body, the whole
 *    module is treated as decrypt-capable. A false positive costs a
 *    restructure; a false negative costs a customer's bucket.
 *
 * And the analysis is proved non-vacuous: the last test feeds the reviewer's
 * exact attack module through the same analyzer and requires it to be caught.
 */


// Every Convex module, twice: once as source to analyze, once as a live module
// so the public/internal classification comes from Convex rather than from a
// naming convention. The ignore list matches `test.setup.ts`.
export const RAW_SOURCES = import.meta.glob(
  [
    "../../**/*.ts",
    "!../../__tests__/**",
    "!../../node_modules/**",
    "!../../*.config.ts",
    "!../../*.setup.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

export const LIVE_MODULES = import.meta.glob(
  [
    "../../**/*.ts",
    "!../../__tests__/**",
    "!../../node_modules/**",
    "!../../*.config.ts",
    "!../../*.setup.ts",
  ],
  { eager: true },
) as Record<string, Record<string, unknown>>;

/** What Convex records on a registered function. */
export interface Classification {
  isPublic: boolean;
  isInternal: boolean;
  kind: "query" | "mutation" | "action" | "http";
}

export interface AnalyzedModule {
  /** Dotted reference path, e.g. `functions.storage`. */
  reference: string;
  /** Human-readable path for failure messages. */
  path: string;
  source: string;
  exports: Record<string, Classification>;
}

export interface Violation {
  node: string;
  reason: string;
}

/** `../../functions/lib/crypto.ts` → `functions.lib.crypto`. The leading `../..` reflects this fixture module living at `__tests__/structure/fixtures.ts`, two directories below `apps/convex`. */
export function referencePath(globKey: string): string {
  return globKey
    .replace(/^(\.\.?\/)+/, "")
    .replace(/\.ts$/, "")
    .split("/")
    .join(".");
}

export function classify(value: unknown): Classification | null {
  const fn = value as {
    isQuery?: boolean;
    isMutation?: boolean;
    isAction?: boolean;
    isHttp?: boolean;
    isPublic?: boolean;
    isInternal?: boolean;
  } | null;
  // A registered Convex function is a *callable* carrying these flags, not a
  // plain object — checking only for "object" here silently classified
  // nothing, which is how a guard ends up passing vacuously.
  if (fn === null || (typeof fn !== "object" && typeof fn !== "function")) {
    return null;
  }

  /**
   * An `httpAction` carries neither `isPublic` nor `isInternal`, because
   * Convex does not route it through the `api`/`internal` object at all — it
   * routes it by **path**, from the public internet, with no argument
   * validator and no function-name gate in front of it.
   *
   * Classified `isPublic: true` here for exactly that reason. It was the hole
   * this whole file exists to close, hiding in plain sight: until this branch
   * existed, `classify` returned `null` for every route in `http.ts`, so the
   * nine control-plane routes were not nodes in the graph, and one of them
   * reaching a decrypted storage credential produced no violation and no
   * failure. An `httpAction` that can open a customer's bucket key is a
   * *more* exposed thing than a public `action`, not a less exposed one.
   *
   * The `kind` is kept distinct so the rules that follow can say something
   * sharper than "public": see `CREDENTIAL_HTTP_ROUTES`.
   */
  if (fn.isHttp === true) {
    return { kind: "http", isPublic: true, isInternal: false };
  }

  const kind = fn.isQuery
    ? "query"
    : fn.isMutation
      ? "mutation"
      : fn.isAction
        ? "action"
        : null;
  if (kind === null) return null;
  return {
    kind,
    isPublic: fn.isPublic === true,
    isInternal: fn.isInternal === true,
  };
}

/**
 * Split a module's source into the block belonging to each `export const`.
 *
 * A block runs from its own declaration to the next one, so anything defined
 * between two exports is attributed to the earlier of the two. That is
 * deliberate: it over-attributes rather than under-attributes, and
 * over-attribution only ever produces a failing test.
 */
export function exportBlocks(source: string): {
  preamble: string;
  blocks: Map<string, string>;
} {
  const declaration = /^export const (\w+)\s*=/gm;
  const found: { name: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    found.push({ name: match[1], index: match.index });
  }

  const preamble =
    found.length === 0 ? source : source.slice(0, found[0].index);
  const blocks = new Map<string, string>();
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].index : source.length;
    blocks.set(found[i].name, source.slice(found[i].index, end));
  }
  return { preamble, blocks };
}

/** Strip `import { … } from "…"` lines: importing a symbol is not calling it. */
export function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

export const DECRYPT_CALL = /\bdecryptSecret\s*\(/;

/**
 * Which modules may import the decrypt at all.
 *
 * `DECRYPT_CALL` above is a text match on a module's own source, and the taint
 * graph's nodes are Convex functions — so a plain helper module that calls
 * `decryptSecret` and declares no Convex function is invisible to both. The
 * public function importing it contains no `decryptSecret(` and passes every
 * check in this file. See the laundering test for the three-line version.
 *
 * So the import is enumerated rather than the call inferred. Both entries here
 * declare Convex functions and are already analyzed properly; adding a third
 * fails this test, which is the point — a new module reaching the decrypt is a
 * conversation, not a merge.
 */
export const DECRYPT_IMPORTERS: ReadonlySet<string> = new Set([
  "functions/storage.ts",
  "functions/cloudflare.ts",
  // THE THIRD, AND WHAT IT OPENS.
  //
  // Not a storage credential and not an account credential: a **PKCE
  // verifier**, parked for the ten minutes between sending somebody to
  // Dropbox and their coming back. It is sealed at rest for the same reason
  // the others are — this table would otherwise hold a live half-credential in
  // the clear — and it is opened in exactly one place, `exchangeAndBind`,
  // which is reachable only by a schedule edge.
  //
  // Worth stating plainly because the argument for a third importer is the
  // argument the comment above says to be suspicious of: it could not call one
  // of the two that already decrypt, because neither has anything to do with
  // an OAuth flow, and folding it into `storage.ts` would put the connect
  // handshake inside the module that serves credentials to the gateway.
  "functions/dropboxConnect.ts",
  // THE FOURTH, AND THE ONLY ONE THAT OPENS NOBODY'S CREDENTIAL BUT OURS.
  //
  // Every importer above holds something belonging to a *customer* — their
  // bucket key, their Cloudflare account, their half-finished Dropbox
  // handshake — and the rules around them exist to keep one tenant's secret
  // away from another tenant and from every client. `appSecrets` is the other
  // direction: the platform's own integration credentials, the Cloudflare
  // token that provisions search databases, a payment provider's key. No
  // tenant is on the other end of one.
  //
  // It is a separate importer rather than a row in `storage.ts` because the
  // two are bound to different things and must stay that way: a storage
  // envelope is sealed to a `workspaceId`, and these are sealed to the
  // `platform:integration` scope (`lib/crypto.ts`), so neither can ever
  // authenticate in the other's place. Putting both in one module would put
  // one keyset call away from the wrong context object.
  //
  // What bounds it: `readIntegrationSecret` is an internalAction with no
  // schedule edge and no route — the only callers are server-side
  // integrations that need the token to make an outbound request. The admin
  // console, which is the only thing that *writes* these rows, cannot read
  // one back: it has `listSecrets`, which returns a fingerprint, and there is
  // deliberately no `getSecret`. If one is ever added, this suite fails.
  "functions/admin.ts",
  // THE FIFTH, AND THE ONLY ONE THAT OPENS A KEY TO NOTE *CONTENT*.
  //
  // Every importer above opens a credential for reaching something — a bucket,
  // an account, an integration. This one opens the workspace data key, which
  // reads one context's encrypted notes directly. That is a different kind of
  // reach and it is written down here rather than folded into `storage.ts`, for
  // the reason the fourth entry gives about the fourth: a workspace data key
  // outlives the binding beside it, so a customer who moves their bucket keeps
  // the key that opens the notes they moved. One module per thing that is
  // sealed to a different lifetime.
  //
  // What bounds it: every export in `functions/encryptionKeys.ts` is
  // `internal*`, so nothing holding a session token or an OAuth grant can route
  // to one; there is no update path for the sealed column, so a second key
  // cannot be written over the first and strand every note under it; and
  // `datakey` is in `PLAINTEXT_CREDENTIAL_FIELDS` above, so a public function
  // returning one by name fails this suite rather than being reviewed.
  //
  // See `docs/decisions/encryption.md`.
  "functions/encryptionKeys.ts",
  // THE SIXTH, AND THE SAME SHAPE AS THE THIRD ONE OVER.
  //
  // `googleConnect.ts` is `dropboxConnect.ts`'s argument, restated for a
  // different OAuth provider and a different credential: a PKCE verifier
  // parked for the ten minutes of a Google consent round trip
  // (`exchangeAndBind`), the account's refresh token opened one last time to
  // disable the WHOLE grant at Google after a disconnect
  // (`revokeGoogleGrant`), and — the one without a Dropbox equivalent — a
  // refresh token opened to mint a short-lived access token for the
  // gateway's sync job (`mintGoogleAccessToken`), the same "hand the gateway
  // minutes, not the standing grant" shape `getBindingForGateway` already
  // uses for a bucket credential. It could not call `storage.ts`'s decrypt
  // path for the same reason `dropboxConnect.ts` could not: neither has
  // anything to do with an OAuth handshake for a *Google account*, and
  // folding a second provider's connect flow into either would put two
  // unrelated handshakes behind one module.
  "functions/googleConnect.ts",
  // THE EIGHTH, AND TEMPORARY BY DESIGN.
  //
  // A paid move keeps the customer's current binding live while it copies to
  // a newly minted managed bucket. The destination secret is sealed in a
  // migration row and opened only by `runManagedStorageMigration`; successful
  // cutover deletes that row, while failure keeps it solely for resumable
  // retry. No public return or route reaches it.
  "functions/managedProvisioning.ts",
  // THE SEVENTH, THE SAME SHAPE AGAIN — ATTACHING A PRODUCT, NOT A SECOND
  // OAUTH-CONNECT MODULE FOR A SECOND PROVIDER.
  //
  // `chatProduct.ts` decrypts a PKCE verifier for its own connect round trip
  // (`exchangeAndBindChat`) — the same reason `googleConnect.ts` has one.
  // It is a sibling file rather than functions added to `googleConnect.ts`
  // itself for the same reason that file gives for not folding Dropbox in:
  // two independent connect flows (Gmail's and Chat's) patching one shared
  // row is a real design, not a reason to interleave their code.
  "functions/chatProduct.ts",
  // THE SEVENTH, AND A PRODUCT ON THE SAME ROW RATHER THAN A NEW PROVIDER.
  //
  // `calendarConnect.ts` opens the same *kind* of thing `googleConnect.ts`
  // does — a PKCE verifier parked for a Google consent round trip — but for
  // a second product's own connect flow, not folded into `googleConnect.ts`
  // itself. It could not call that module's decrypt path directly because
  // that path lives inside `exchangeAndBind`'s own internalAction, private
  // to Gmail's binding shape (backfill days, folders, attachment mode) that
  // a Calendar-only connect carries none of; sharing the helpers that do not
  // touch a credential (`requireGoogleClientId`, `requireActor`, …) is what
  // `googleConnect.ts` exports them for, and this is what still needs its
  // own verifier-opening step. Reused, not re-derived: `mintGoogleAccessToken`
  // and `revokeGoogleGrant` in `googleConnect.ts` already serve every
  // product on the grant, so this module adds exactly one new decrypt site,
  // not three.
  "functions/calendarConnect.ts",
  // THE NINTH, AND THE FIRST CREDENTIAL THAT IS NOT OURS TO ROTATE.
  //
  // `providers.ts` holds the API key for the model account the agent spends —
  // the customer's own Anthropic or OpenAI key — and opens it in exactly one
  // place, `openProviderCredential`, whose only caller is the gateway. Its own
  // module for the reason the sixth entry gives: one module per thing sealed
  // to a different lifetime. This one outlives no binding and is bound to no
  // handshake; it is replaced when somebody pastes a new key and deleted when
  // they disconnect, and folding it into `storage.ts` would put a credential
  // with that lifetime behind a module whose every other secret belongs to a
  // bucket.
  //
  // What bounds it: `connectProvider` and `listProviders` are the only public
  // exports and neither reaches the decrypt — the first encrypts, the second
  // builds its answer field by field from the row and never touches
  // `encryptedApiKey`. The refusals are written to name the provider and never
  // the key, because a credential we did not issue is one we cannot rotate
  // after a leak, and #661 put a credential we *could* rotate into the
  // production logs by way of a validation error.
  //
  // See `__tests__/providerCredentials.test.ts`, which drives every failing
  // path and searches the thrown value for the key it was given.
  "functions/providers.ts",
]);

/** An import of `decryptSecret`, in code rather than in prose. */
export function importsDecrypt(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return /import\s*\{[^}]*\bdecryptSecret\b[^}]*\}\s*from/.test(
    withoutComments,
  );
}
const CONVEX_REFERENCE = /\b(?:internal|api)((?:\.[A-Za-z_$][\w$]*)+)/g;
const RUN_CALL = /\.run(?:Query|Mutation|Action)\(\s*([^,)\s]*)/g;
/**
 * `ctx.scheduler.runAfter(delay, internal.x.y, …)` / `runAt(when, …)`.
 *
 * The delay expression is matched as "everything up to the first comma", so a
 * delay that itself contains a comma (`Math.max(0, n)`) will not match here.
 * That is a fail-closed miss, not a hole: with no scheduler span recorded, the
 * reference that follows is counted as an ordinary call edge and propagates
 * taint exactly as before.
 */
const SCHEDULE_CALL = /\.scheduler\.run(?:After|At)\(\s*[^,]*,\s*([^,)\s]*)/g;

/**
 * THE CREDENTIAL BARRIER SET.
 *
 * Every function here is decrypt-capable **and** may be called by a public
 * function. Taint stops at a barrier: its callers do not inherit it.
 *
 * That is a real relaxation of the property this file used to enforce — that
 * no public function could reach a credential *at all* — and it was added
 * deliberately, because the alternative is that a person can never read or
 * write their own bucket from the console. A read path has to obtain a
 * credential somewhere, and no static rule can prove that a function which
 * holds one does not leak it: a `returns: v.string()` handler could return
 * `credential.secretAccessKey` and satisfy any validator-based check.
 *
 * So the barrier is not a *proof*, it is a **pin**. What it buys:
 *
 *  - The set is enumerated here, by name. Adding a second one is a diff to
 *    this file that a reviewer sees, exactly like adding to the
 *    decrypt-capable list below.
 *  - Everything else is unchanged. A public function that calls
 *    `getBindingForGateway` directly — the reviewer's original attack — still
 *    fails, because that function is not a barrier. So does one that calls
 *    `verifyStorageBinding`, or any *new* internal function that opens a
 *    credential without being listed here.
 *  - The barrier's own return validator is checked for credential fields (see
 *    the test below), and `__tests__/fileContent.test.ts` asserts
 *    behaviourally that no credential and no note content reaches a caller,
 *    an audit row, or an error.
 *
 * A barrier earns its place by being small enough to read in one sitting and
 * by doing exactly one thing with the credential. `runFileOperation` builds one
 * `S3Store` and hands it to `lib/fileOps.ts`, which has no access to the
 * credential at all. **Do not add one without that property.**
 */
/**
 * The second member. Read the paragraph above before adding a third.
 *
 * `functions.encryptionKeys.exportWorkspaceDataKeys` decrypts every generation
 * of a workspace's data key and returns the plaintext material — the console's
 * `exportEncryptionKeys` and the gateway's `export_encryption_keys` are both
 * `docs/decisions/encryption.md`'s "Revocation and export": the customer must
 * be able to get the key itself, not only decrypt with it through us, or the
 * first non-negotiable is false the moment they leave — by revoking our
 * credential on their own bucket, or by exporting off managed storage. That is
 * a *deliberate* disclosure this codebase has never needed before — every
 * other barrier and every other decrypt-capable function returns something
 * *derived* from a credential (file content, a signed request); this is the
 * first that hands back the credential itself, on purpose, to its owner.
 *
 * What makes it small enough to be a barrier and not a hole: it performs no
 * authorization of its own. `authorizeEncryptionExport` — a *different*,
 * non-barrier internal mutation — checks the owner role, spends the rate
 * limit, and writes the audit row, all three in one transaction, before the
 * console's public `exportEncryptionKeys` action ever calls this one. A
 * barrier that also decided who may call it would be two things to get right
 * instead of one; this one does exactly the thing `runFileOperation` does —
 * open a credential and hand back the single value its caller asked for.
 */
export const CREDENTIAL_BARRIERS = new Set([
  "functions.files.runFileOperation",
  "functions.encryptionKeys.exportWorkspaceDataKeys",
]);

/**
 * Every `encrypted*` column in the schema, lowercased — read from the schema
 * rather than typed out here.
 *
 * The two credential-field guards below match **specific field names**, so
 * until this existed they protected exactly the names somebody remembered to
 * add. That is the failure this file already documents one guard over: a
 * credential check that grepped export names, defeated by a rename in a new
 * file. A second credential shape — an OAuth refresh token beside an S3
 * secret, say — arrives as a new column with a new name, and a hand-maintained
 * list does not know about it. The list would still be green, and the guard
 * would be blind to precisely the field nobody had thought about yet.
 *
 * Deriving it means a new encrypted column is forbidden in a public return
 * validator from the moment it is declared, with nobody needing to remember.
 * `ENVELOPE_FIELDS` in `functions/storage.ts` is coupled to the schema the
 * same way and for the same reason.
 */
export function encryptedColumnsIn(schemaSource: string): string[] {
  const names = [
    ...schemaSource.matchAll(/^\s+(encrypted[A-Za-z0-9]*)\s*:/gm),
  ].map((match) => match[1]!.toLowerCase());
  return [...new Set(names)];
}

/**
 * The schema's source: `schema.ts` plus the table modules it spreads in from
 * `functions/lib/schema/`.
 */
function schemaSource(): string | undefined {
  const entry = RAW_SOURCES["../../schema.ts"];
  if (typeof entry !== "string") return undefined;
  const tables = Object.keys(RAW_SOURCES)
    .filter((key) => key.startsWith("../../functions/lib/schema/"))
    .sort()
    .map((key) => RAW_SOURCES[key] as string);
  return [entry, ...tables].join("\n");
}

export const SCHEMA_ENCRYPTED_FIELDS = (() => {
  const source = schemaSource();
  if (typeof source !== "string") {
    throw new Error(
      "structure.test.ts could not read schema.ts to derive credential fields",
    );
  }
  return encryptedColumnsIn(source);
})();

/**
 * Plus the ones that are credentials without being encrypted at rest.
 *
 * `secretaccesskey` is the plaintext half nothing should ever return;
 * `accesskeyid` names the credential's public half, forbidden to a barrier
 * because a barrier returning half a key pair has already returned too much.
 */
export const PLAINTEXT_CREDENTIAL_FIELDS = [
  // The S3 secret, and the Dropbox one. `accesstoken` matters as much as
  // `secretaccesskey` and is easier to miss, because it is the *decrypted*
  // half — the value `getBindingForGateway` hands the gateway, not an envelope
  // with an offline step in front of it. It never appears as a schema column,
  // so the derivation above cannot find it: at rest Dropbox is stored as
  // `encryptedAccessToken`, and the bare `accessToken` exists only in flight.
  // A guard that only reads the schema is a guard that only knows the shapes
  // that sit still.
  "secretaccesskey",
  "accesstoken",
  // THE D1 WRITE TOKEN, which `/gateway/binding` now returns beside the bucket
  // key as `searchIndex.apiToken`. It is the platform's own credential rather
  // than a customer's, and it is wider than one context — `D1:Edit` on the whole
  // account — which is exactly why a public function returning a field by this
  // name should fail rather than be reviewed. Like `accesstoken` it never
  // appears as a schema column, because at rest it is one `appSecrets` row's
  // `encryptedValue` and the bare token exists only in flight.
  "apitoken",
  // THE WORKSPACE DATA KEY, which `/gateway/binding` returns beside the bucket
  // key. It opens every encrypted note in one context, which puts it in the
  // same class as `secretaccesskey` rather than a lesser one. At rest it is
  // `workspaceDataKeys.encryptedDataKey` — a column the derivation above
  // already finds — and the opened material exists only in flight, so it is
  // named here for the same reason `accesstoken` is: the schema-derived list
  // can only know the shapes that sit still.
  //
  // TWO NAMES, AND THE SECOND ONE IS THE POINT. The field was `dataKey` until
  // workspace-key rotation made a context's keys a set rather than one value;
  // it is now `encryptionKey.keys` on that route and `material` per entry in a
  // key export. `datakey` stays listed anyway — nothing declares it today, and
  // a list that drops a credential name the moment the last user of it is
  // renamed is a list that goes quiet exactly when somebody reintroduces the
  // old shape. `material` joins it, because the rename is otherwise the whole
  // of what moved this credential out from under the guard, and "a credential
  // check that grepped export names, defeated by a rename in a new file" is
  // the first entry in `docs/decisions/testing.md`'s list of guards that were
  // weaker than they looked.
  //
  // The two functions that may declare `material` are enumerated in
  // `DELIBERATE_KEY_DISCLOSURES` below. A third fails this suite, loudly,
  // which is the conversation that enumeration exists to force.
  "datakey",
  "material",
];

/**
 * THE FUNCTIONS ALLOWED TO HAND BACK KEY MATERIAL, BY NAME.
 *
 * `docs/decisions/encryption.md`'s "Revocation and export": the first
 * non-negotiable is only true if a customer can get the key itself, so exactly
 * two functions in this control plane are permitted to return one —
 * `exportWorkspaceDataKeys`, the barrier that opens every generation, and
 * `exportEncryptionKeys`, the console action that spends the rate limit and
 * writes the audit row before calling it.
 *
 * Everything else in the credential-field guards applies to them as it always
 * did; this exempts them from the ONE field name that describes the disclosure
 * they exist to make. It is an allowlist and not a widening: a third function
 * declaring a `material` field fails, and so does either of these two growing
 * a `secretaccesskey`, an `apitoken` or an `encrypteddatakey`.
 */
export const DELIBERATE_KEY_DISCLOSURES = new Set([
  "functions.encryptionKeys.exportWorkspaceDataKeys",
  "functions.encryptionKeys.exportEncryptionKeys",
]);

/** The one field those two are exempt from, and nothing else. */
export const DISCLOSED_KEY_FIELD = "material";

/**
 * THE FUNCTION ALLOWED TO HAND BACK A TOKEN IT JUST MINTED, BY NAME.
 *
 * A different question from `DELIBERATE_KEY_DISCLOSURES` above, kept apart
 * because the answer is different: that one discloses a *stored* key, and this
 * one returns a credential that did not exist a line earlier and describes
 * nothing but the caller's own session.
 *
 * `mintConsoleGrant` is the console's own OAuth grant. The agent turn runs in
 * the gateway — that is where the privacy engine and the tools are, and where a
 * model key is decrypted — and the gateway authenticates with an access token
 * and nothing else. The console has a Convex session and has never held one, so
 * something has to issue it. What is issued is an ordinary `oauthGrants` row:
 * same table, same `resolveGrantByAccessToken`, same `clampScopes` against the
 * role read in that transaction, same revocation from the connections list,
 * same audit. Only the plaintext travels back, and only to the person it was
 * minted for.
 *
 * **The precedent it is enumerated against, rather than hidden behind.**
 * `approveOwnMachineGrant` is already a public action that hands its caller a
 * freshly minted secret about themselves — an authorization code, live, inside
 * the URL it returns. It passes this guard for one reason: the field is called
 * `redirectTo`. That is the rename `PLAINTEXT_CREDENTIAL_FIELDS`' own comment
 * warns about, arrived at honestly rather than to evade anything, and it is
 * exactly why this one is listed here instead of having its field renamed to
 * `token` or `session` to slip past.
 *
 * What bounds the disclosure: an hour, no refresh token, one live grant per
 * person per context (the previous token dies in the transaction that mints the
 * next), and a caller who must already hold the Convex session — which reaches
 * the same notes through `files.ts` and can additionally rebind storage and
 * delete the account. The token is the smaller of the two powers.
 *
 * It is an allowlist and not a widening. A second function returning an
 * `accesstoken` fails, and so does this one growing a `secretaccesskey`, an
 * `apitoken` or an `encryptedapikey`. See `__tests__/agentGrant.test.ts`.
 */
export const DELIBERATE_TOKEN_MINTS = new Set(["functions.agentGrant.mintConsoleGrant"]);

/** The one field that one is exempt from, and nothing else. */
export const MINTED_TOKEN_FIELD = "accesstoken";

export const PUBLIC_FORBIDDEN_FIELDS = [
  ...new Set([...PLAINTEXT_CREDENTIAL_FIELDS, ...SCHEMA_ENCRYPTED_FIELDS]),
];
export const BARRIER_FORBIDDEN_FIELDS = [
  ...new Set([
    ...PLAINTEXT_CREDENTIAL_FIELDS,
    "accesskeyid",
    ...SCHEMA_ENCRYPTED_FIELDS,
  ]),
];

/**
 * THE HTTP ROUTES THAT MAY REACH A CREDENTIAL.
 *
 * There are two, and there is a reason it cannot be zero: the whole product is
 * a worker in another datacentre signing S3 requests with the customer's own
 * key, and the only way it gets that key is over HTTPS from here.
 * `/gateway/binding`'s *purpose* is to return a decrypted secret, and so is
 * `/gateway/ingest/binding`'s.
 *
 * ── The second entry, and what it costs ─────────────────────────────────────
 *
 * `/gateway/ingest/binding` was added with the Email Worker, and it is exactly
 * what the paragraph below warns about: a second internet-facing path to other
 * people's bucket keys. It is here rather than folded into the first because it
 * cannot present the same proofs. `/gateway/binding` requires an end user's
 * access token and derives the workspace from that grant; an inbound email has
 * no user token, because nobody is present and nothing was authorized just now.
 *
 * What it keeps, and what is checked below: the caller still cannot name a
 * context. It presents a ticket the control plane minted, bound at mint time to
 * whatever `resolvePersonalContextForIngestion` answered for a name a *sender*
 * typed. What it gives up is "a real person authorized this just now", and the
 * bound is that a stolen `EMAIL_WORKER_SECRET` reaches one ingestion-enabled
 * personal context's credential per single-use, five-minute ticket, rate-limited
 * per name, and no shared context ever.
 *
 * Any additional entry would need the same argument made again, in this comment.
 *
 * So this is not a barrier and must not be read as one. A barrier stops taint
 * propagating — everything that calls through it comes out clean, which is why
 * `CREDENTIAL_BARRIERS` has one member and a long warning attached. This is a
 * **pin**: the route is still decrypt-capable, it still appears in the
 * enumerated `decryptCapable` set below, and every *other* http route in the
 * codebase still fails if it can reach a credential. Adding an entry here is a
 * diff a reviewer sees, and it means another internet-facing path
 * to other people's bucket keys.
 *
 * What keeps the exemption honest, all enforced below:
 *
 *  - the route must actually be an `httpAction` and must actually be
 *    decrypt-capable, or the pin is stale;
 *  - **every** route in `http.ts` — this one included — must be built by the
 *    `gatewayRoute` factory, and that factory must require the gateway secret,
 *    so no route can be added that skips proof #1;
 *  - `expectedWorkspaceId` must never be used as a lookup key anywhere, which
 *    is what keeps proof #2 meaningful: the workspace comes from the grant the
 *    user's token resolved to, and the caller cannot name the workspace it
 *    gets.
 *
 * None of that proves the route does not leak. Nothing static can. It bounds
 * the blast radius to one reviewed, two-factor-authenticated path, and
 * `__tests__/controlPlane.test.ts` carries the behavioural half.
 */
export const CREDENTIAL_HTTP_ROUTES = new Set([
  "http.gatewayBinding",
  "http.gatewayJobsOpen",
  "http.gatewayIngestBinding",
  // THE FOURTH, AND THE ONLY ONE ADDED RATHER THAN AVOIDED.
  //
  // `searchIndex`, `encryptionKey` and `rotation` all became *siblings* on
  // `/gateway/binding` specifically so this set would stay at three, and that
  // remains the default answer for a new gateway-facing credential. The model
  // key is the exception, for a reason that is about #661 rather than about
  // convenience: `openStorageBinding`'s returns validator already carries
  // `secretAccessKey`, and `v.object` is exact, so any drift in that shape
  // serializes everything in it into a log. Folding a customer's provider key
  // in would make one accident spill two credentials.
  //
  // What makes the door cost little: it is built by the same `gatewayRoute`
  // factory, spends the same two proofs, applies the same
  // compared-never-looked-up rule to `expectedWorkspaceId`, and answers `null`
  // for everything that is not a hit — all of which the tests below enforce on
  // it exactly as they do on the other three. What it does not share is the
  // validator, which is the entire point: two flat fields, nothing nested.
  "http.gatewayProvider",
]);
/**
 * Build the graph and return every way a public function can reach a decrypt.
 *
 * Pure over its input so the same analyzer can be pointed at the real codebase
 * and at a synthetic attack module — see the final test.
 */
export function analyze(modules: AnalyzedModule[]): {
  violations: Violation[];
  decryptCapable: Set<string>;
} {
  const violations: Violation[] = [];
  const decryptCapable = new Set<string>();
  const edges = new Map<string, string[]>();
  const classifications = new Map<string, Classification>();
  const knownNodes = new Set<string>();

  for (const module of modules) {
    for (const name of Object.keys(module.exports)) {
      knownNodes.add(`${module.reference}.${name}`);
    }
  }

  for (const module of modules) {
    const { preamble, blocks } = exportBlocks(module.source);

    // Fail closed: a decrypt reached from a module-level helper cannot be
    // attributed to one export, so every export in the module inherits it.
    // Superseded by `moduleWideTaintFromHelpers` below, which covers this
    // case and the one it missed.

    // Same fail-closed rule for *call edges*, and it is the hole the barrier
    // set would otherwise open. A module-level helper like
    //
    //   async function openStore(ctx, id) {
    //     return await ctx.runAction(internal.functions.storage.getBindingForGateway, …);
    //   }
    //
    // belongs to no Convex function, so its reference would be counted for
    // nobody — a public action could call it and the graph would see nothing.
    // Every export in the module inherits references found in unattributed
    // text.
    //
    // **Unattributed is not the same as "above the first export", and the
    // difference was a live hole.** `exportBlocks` splits on `export const`,
    // so a helper written *after* a non-function export —
    //
    //   export const SOME_NAME = "…";      // not a Convex function
    //   async function openStore(ctx) { … } // lands in SOME_NAME's block
    //
    // was attributed to that constant's block. A constant is not a registered
    // Convex function, so it is not in `module.exports`, so it is not a node,
    // so the edge was dropped on the floor. Found by writing a provisioner
    // whose credential read sits in exactly that position: the analyzer said
    // it reached no decrypt, and it plainly did.
    //
    // So the unattributed text is the preamble *plus every block whose name is
    // not a Convex function this analysis knows about*.
    const unattributed = [preamble];
    for (const [blockName, blockText] of blocks) {
      if (!(blockName in module.exports)) unattributed.push(blockText);
    }
    const moduleWideTaintFromHelpers = unattributed.some((text) =>
      DECRYPT_CALL.test(withoutImports(text)),
    );

    const preambleTargets: string[] = [];
    for (const text of unattributed) {
      const stripped = withoutImports(text);
      let found: RegExpExecArray | null;
      CONVEX_REFERENCE.lastIndex = 0;
      while ((found = CONVEX_REFERENCE.exec(stripped)) !== null) {
        const target = found[1].slice(1);
        if (knownNodes.has(target)) preambleTargets.push(target);
      }
    }

    for (const [name, classification] of Object.entries(module.exports)) {
      const node = `${module.reference}.${name}`;
      classifications.set(node, classification);

      // An export the block splitter cannot locate — `export const { a, b } =`
      // (how the auth framework re-exports its functions), or a
      // `const x = query(…); export { x }` — falls back to the whole module as
      // its body. Conservative on purpose: a function whose definition cannot
      // be pinpointed inherits everything its file reaches, so hiding a call
      // behind an indirect export makes the analysis *more* suspicious of it,
      // not blind to it.
      const body = blocks.get(name) ?? module.source;
      if (moduleWideTaintFromHelpers || DECRYPT_CALL.test(body)) {
        decryptCapable.add(node);
      }

      let match: RegExpExecArray | null;

      // Scheduling is not calling, and the difference is the whole reason the
      // connect flow can exist. `ctx.runQuery/runMutation/runAction` awaits a
      // value and hands it to the caller, so a public function that runs a
      // decrypting internal function has that credential in its own scope —
      // that is the edge this graph exists to forbid. `ctx.scheduler.runAfter`
      // enqueues a job in a *separate* transaction whose return value the
      // scheduler discards; there is no channel back to whoever queued it, so
      // it cannot hand a credential to a public caller.
      //
      // The distinction is load-bearing rather than a convenience: without it
      // no public function could ever trigger a bucket probe, and "verify the
      // credential the user just pasted" would have to be a polling cron
      // chosen to satisfy a static check rather than because it is the right
      // design.
      //
      // Two things keep it honest, both enforced below:
      //   - a scheduled target must still be a statically resolvable
      //     `internal.…` reference, so nothing hides behind a computed name
      //     or reaches a *public* function, and
      //   - only the reference in the scheduler's argument position is
      //     exempted. The same function named anywhere else in the same body
      //     is still an ordinary call edge.
      //
      // What it does not prove is that a scheduled job never *stores* a
      // plaintext credential somewhere a public query could read it. No static
      // rule can; `__tests__/provisioning.test.ts` asserts behaviourally that
      // the credential appears in no recorded error, audit event, or return
      // value, and the public return-validator check below is the second net.
      const scheduledSpans: [number, number][] = [];
      SCHEDULE_CALL.lastIndex = 0;
      while ((match = SCHEDULE_CALL.exec(body)) !== null) {
        const argument = match[1];
        const start = match.index + match[0].length - argument.length;
        scheduledSpans.push([start, start + argument.length]);
        if (!/^internal\./.test(argument)) {
          violations.push({
            node,
            reason: `schedules ${argument || "<unparsed>"}, which is not a statically resolvable internal function reference — a scheduled target must be nameable, or the credential-reachability graph cannot see what was queued`,
          });
        }
      }
      const isScheduledReference = (index: number) =>
        scheduledSpans.some(([start, end]) => index >= start && index < end);

      const targets: string[] = [];
      CONVEX_REFERENCE.lastIndex = 0;
      while ((match = CONVEX_REFERENCE.exec(body)) !== null) {
        const target = match[1].slice(1);
        if (!knownNodes.has(target)) continue;
        if (isScheduledReference(match.index)) continue;
        targets.push(target);
      }
      edges.set(node, [...targets, ...preambleTargets]);

      // Every `ctx.runX` must name a statically resolvable function, or the
      // graph above is a fiction.
      RUN_CALL.lastIndex = 0;
      while ((match = RUN_CALL.exec(body)) !== null) {
        const argument = match[1];
        if (!/^(internal|api)\./.test(argument)) {
          violations.push({
            node,
            reason: `calls ctx.run…(${argument || "<unparsed>"}), which cannot be resolved statically — the credential-reachability graph cannot see through it`,
          });
        }
      }
    }
  }

  // Propagate capability backwards until nothing new is tainted.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, targets] of edges) {
      if (decryptCapable.has(node)) continue;
      // Taint stops at a barrier — see CREDENTIAL_BARRIERS above for what
      // that buys and, just as importantly, what it does not.
      if (
        targets.some(
          (target) =>
            decryptCapable.has(target) && !CREDENTIAL_BARRIERS.has(target),
        )
      ) {
        decryptCapable.add(node);
        changed = true;
      }
    }
  }

  for (const node of decryptCapable) {
    const classification = classifications.get(node);
    if (classification?.kind === "http") {
      // An HTTP route is reachable from the internet by path. One of them has
      // to hand the gateway a decrypted credential; the rest must not be able
      // to, and which one is which is pinned by name.
      if (!CREDENTIAL_HTTP_ROUTES.has(node)) {
        violations.push({
          node,
          reason:
            "is an HTTP route that can transitively reach the storage-secret decrypt path, and is not one of the enumerated CREDENTIAL_HTTP_ROUTES",
        });
      }
      continue;
    }
    if (classification?.isPublic) {
      violations.push({
        node,
        reason:
          "is a PUBLIC Convex function that can transitively reach the storage-secret decrypt path",
      });
    }
  }

  return { violations, decryptCapable };
}

export function findViolations(modules: AnalyzedModule[]): Violation[] {
  return analyze(modules).violations;
}

export function realModules(): AnalyzedModule[] {
  return Object.keys(RAW_SOURCES).map((globKey) => {
    const exports: Record<string, Classification> = {};
    for (const [name, value] of Object.entries(LIVE_MODULES[globKey] ?? {})) {
      const classification = classify(value);
      if (classification !== null) exports[name] = classification;
    }
    return {
      reference: referencePath(globKey),
      path: globKey.replace(/^(\.\.?\/)+/, ""),
      source: RAW_SOURCES[globKey],
      exports,
    };
  });
}
