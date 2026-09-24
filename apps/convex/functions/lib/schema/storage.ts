import { defineTable } from "convex/server";
import { v } from "convex/values";
import { storageLayoutStateValidator } from "../storageLayout";

/**
 * The one storage binding per workspace, and the credential sealed inside it.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const storageTables = {
  /**
   * The customer's bucket credential.
   *
   * KEYED BY `workspaceId`, NEVER `userId`. A binding belongs to the context,
   * not to the person who happened to paste the key — otherwise every shared
   * context becomes a migration instead of a row.
   *
   * `rootPrefix` is optional and is applied at the storage-adapter boundary
   * only. It is NOT tenancy: we never namespace keys inside a customer bucket,
   * so a bucket that already looks like a Context workspace connects unchanged.
   *
   * `encryptedSecretAccessKey` is an opaque envelope produced by
   * `functions/lib/crypto.ts` (`v2:<key-id>:<iv-b64>:<ciphertext-b64>`). The
   * plaintext secret is never stored, never returned by a public function, and
   * is decrypted only by an internal function serving the gateway. The
   * envelope is bound to this row's `workspaceId` as AES-GCM additional
   * authenticated data, so moving it to another workspace's row makes it
   * undecryptable rather than portable.
   */
  storageBindings: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.union(
      v.literal("r2"),
      v.literal("s3"),
      v.literal("b2"),
      v.literal("s3-compatible"),
      v.literal("dropbox"),
    ),
    /**
     * ## Two shapes in one table, and why the S3 fields became optional
     *
     * Every field below used to be required, because every binding was a
     * bucket. Dropbox has no endpoint, no region, no bucket and no access key
     * — it has an OAuth grant and a folder — so the S3 five are now optional
     * and **which set is required is a function of `provider`**.
     *
     * That is a real loss: the schema no longer refuses a half-built binding
     * on its own. It is bought back in `bindStorage`, which validates per
     * provider before writing, and in the gateway, which rejects a binding
     * missing what its own provider needs rather than half-building a store.
     * Both have tests. A validator that cannot express "these five together or
     * those two together" is the trade; splitting into two tables would put
     * the workspace→storage relationship in two places, which is worse.
     */
    endpoint: v.optional(v.string()),
    region: v.optional(v.string()),
    bucket: v.optional(v.string()),
    /**
     * The folder inside the customer's storage, applied at the adapter
     * boundary and invisible above it.
     *
     * For S3 this is the optional prefix inside a bucket. For Dropbox it is
     * the folder inside the app folder, and it is how one Dropbox account
     * holds more than one context.
     *
     * **It is the customer's choice, never ours.** `CLAUDE.md` forbids
     * namespacing somebody's storage on their behalf; a prefix we derived and
     * did not show them is exactly that, wearing a different name. Pre-fill it
     * in the console, show it, let them change it — do not compute it silently
     * from a workspace id.
     */
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.optional(v.string()),
    encryptedSecretAccessKey: v.optional(v.string()),
    /**
     * The Dropbox grant. Envelopes from `encryptSecret`, exactly like the S3
     * secret, and subject to the same rule: never returned by a
     * client-callable function, never logged.
     *
     * **The refresh token never leaves the control plane.** The gateway is
     * handed a short-lived access token and nothing else, so a compromised
     * gateway yields minutes of one workspace's storage rather than the
     * standing ability to mint tokens for it. That is the same reasoning as
     * "never cache a decrypted credential across requests", one layer up.
     *
     * `accessTokenExpiresAt` exists so a refresh happens on a schedule rather
     * than on a 401: discovering expiry by failing a customer's read is a
     * worse way to find out, and Dropbox's access tokens are short by design.
     */
    encryptedRefreshToken: v.optional(v.string()),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    /**
     * Whose Dropbox this is. Not a secret and not a credential — it is what
     * lets the console say which account is connected, and lets a reconnect
     * notice that a *different* account just arrived, which is the difference
     * between "you signed in again" and "your context now points somewhere
     * else".
     */
    dropboxAccountId: v.optional(v.string()),
    /**
     * How the bucket is addressed in a request URL: as a path segment
     * (`https://endpoint/my-context/note.md`) or as the first host label
     * (`https://my-context.s3.example/note.md`).
     *
     * **Absent means "let the adapter decide", and that is the right default
     * for almost everybody.** R2 and the classic AWS regional endpoints are
     * path-style, which is what `S3Store` assumes when nothing says otherwise,
     * so the overwhelming majority of bindings never carry this field.
     *
     * It exists because there is exactly one case the adapter refuses to guess:
     * an endpoint whose first host label *is* the bucket name. That shape is
     * produced both by a genuine virtual-hosted endpoint
     * (`https://my-context.s3.amazonaws.com`) and by a path-style one that
     * collides by coincidence (`s3.wasabisys.com` with a bucket called `s3`).
     * Guessing wrong means signing requests against a different bucket than the
     * customer named — a silent wrong-bucket write — so `S3Store` throws
     * instead, and `bindStorage` refuses the binding up front with an error
     * that names the two answers. Storing the answer is what makes the refusal
     * fixable rather than a dead end.
     *
     * Emitted to the gateway verbatim (`binding.forcePathStyle` in the
     * control-plane contract) so the adapter that signs the request and the
     * adapter that probed the bucket address it identically.
     */
    forcePathStyle: v.optional(v.boolean()),
    /**
     * Probed at connect time, not assumed. R2 and AWS S3 support conditional
     * writes; B2 and Wasabi do not reliably. We degrade honestly rather than
     * silently dropping conflict detection.
     *
     * **Every field but `conditionalWrite` is optional because it was added
     * after bindings existed, and absent does not mean `false` — it means
     * nobody has asked yet.** The gateway cannot tell those apart and must
     * fail closed (`store/factory.js`), so an absent field disables the
     * feature it describes: bindings verified before 2026-09-12 carried no
     * `conditionalDelete` and every move on them refused, on R2 included,
     * until `sweepUnprobedCapabilities` re-probed them. Adding a capability
     * here is therefore adding a backfill: the sweep's `UNPROBED` predicate
     * is what makes a new field reach the rows that already exist.
     */
    capabilities: v.object({
      conditionalWrite: v.boolean(),
      conditionalCreate: v.optional(v.boolean()),
      conditionalDelete: v.optional(v.boolean()),
      serverSideCopy: v.optional(v.boolean()),
    }),
    status: v.union(
      v.literal("unverified"),
      v.literal("connected"),
      v.literal("error"),
    ),
    lastVerifiedAt: v.optional(v.number()),
    /**
     * Provider-side failure text, truncated and scrubbed on the way in by
     * `recordVerification` — see the redaction there for exactly what is
     * enforced and what is only convention. Any member of the workspace can
     * read this field, so treat it as published.
     */
    lastError: v.optional(v.string()),
    /**
     * The machine-readable half of `lastError`.
     *
     * `lastError` is provider prose: it is written for a human, it is scrubbed
     * and truncated, and it changes whenever a provider rewords a message. A UI
     * that wants to offer "fix the addressing style" for one failure and "paste
     * the key again" for another cannot key off that string without matching on
     * text, so a code is recorded alongside it. The set is enumerated in
     * `functions/provisioning.ts` (`VerificationErrorCode`); anything not in it
     * should be treated by a client as "unknown, show `lastError`".
     *
     * Cleared on success, exactly like `lastError` — a stale code next to a
     * green status misdiagnoses support tickets just as effectively as stale
     * prose.
     */
    errorCode: v.optional(v.string()),
    /**
     * WHAT WE FOUND IN THE BUCKET, AND WHAT WE DID ABOUT IT.
     *
     * This pair is the whole reason onboarding can stop asking a question it
     * can answer itself. `verifyStorageBinding` already looks at the bucket in
     * order to decide whether scaffolding is safe; before these fields existed
     * that conclusion was computed, used, and thrown away, so a client had no
     * way to tell "your context is already here" from "this bucket is empty"
     * without a credential of its own.
     *
     * `scaffolded` — did *we* write files. False for a bucket that already had
     * a context, and false for one we have only looked at.
     *
     * `scaffoldReason` — a code from a closed set (`ScaffoldState` in
     * `functions/provisioning.ts`):
     *
     *  - `existing-context` — the bucket already holds somebody's notes.
     *    Nothing was written and nothing will be. **Do not prompt for a
     *    structure; there is one.**
     *  - `empty`           — verified, reachable, writable, and empty. This is
     *    the only state in which asking PARA-or-custom makes sense.
     *  - `created`         — a starting layout was written, in full.
     *  - `partial`         — the essential file landed and something
     *    best-effort did not. **This is a success**: the bucket is a working
     *    context. `scaffoldMissing` says what is absent.
     *  - `failed`          — an essential file did not land. Not a context yet.
     *  - `not-attempted`   — verification did not get far enough to look.
     *
     * Both absent on a binding that has never been verified. Readable by every
     * member, like the rest of this row; neither carries note content, a key
     * name, or anything a client did not already send us.
     */
    scaffolded: v.optional(v.boolean()),
    scaffoldReason: v.optional(v.string()),
    /**
     * WHAT WE STILL OWE THIS BUCKET.
     *
     * Keys of the layout the owner chose that are not in the bucket: written
     * by every scaffold attempt, empty once one completes, absent until one
     * runs. Two jobs, and the second is the load-bearing one:
     *
     *  1. It is the honest half of `partial` — the console can name the two
     *     READMEs that did not land, instead of calling the whole thing failed.
     *  2. **It is how we tell our own half-written scaffold from a vault that
     *     was here before we arrived.** Both look like "the bucket already
     *     holds a context" to anything reading the bucket, and treating them
     *     the same is what made a partly-failed scaffold impossible to finish
     *     through the product (issue #22). This field can only ever be
     *     non-empty because *we* observed this bucket empty and then wrote into
     *     it — so a non-empty value is the licence `applyStructure` needs to
     *     retry, and `bindStorage` clears it, because it describes one bucket.
     *
     * Key names this control plane generated. Never provider text, never note
     * content.
     */
    scaffoldMissing: v.optional(v.array(v.string())),
    /**
     * HOW MANY NOTES WERE IN THE BUCKET WHEN SOMETHING LAST LOOKED.
     *
     * A count, a timestamp, and whether the count is a total or a floor. All
     * three absent until a verification has actually walked the bucket, and
     * that absence is load-bearing: issue #25 was the console printing "1,284
     * objects" over a bucket holding six, from a constant nobody had measured.
     * A missing value must cost a tile rather than produce a plausible one.
     *
     * `noteCountedAt` is separate from `lastVerifiedAt` on purpose. A
     * verification can succeed and still learn nothing about the contents — the
     * listing failed partway, or the walk hit its budget — and a tile that
     * dated its number from the last *verification* would be attributing a
     * stale count to a fresh look.
     *
     * `noteCountTruncated` travels with the number everywhere it goes. The walk
     * is bounded (`lib/noteCount.ts`), so a large enough context yields a floor,
     * and a floor rendered as a total is #25 with extra steps.
     *
     * Metadata, not content: three numbers about somebody's bucket, no key
     * names, no note text. This is the same category as `scaffolded` — a thing
     * we observed at a moment we held a credential, which a query cannot
     * recompute without becoming a public function that opens one.
     */
    noteCount: v.optional(v.number()),
    noteCountedAt: v.optional(v.number()),
    noteCountTruncated: v.optional(v.boolean()),
    /**
     * WHERE THE STORAGE-LAYOUT MIGRATION GOT TO, AND WHEN WE LAST HEARD.
     *
     * The authoritative record is in the bucket — `migrateStorageLayout`
     * persists it under `.context/` and short-circuits on `complete` — and
     * that is where it stays: this is a **copy of an outcome we observed**, in
     * the same category as `scaffolded` and `noteCount`, kept because a query
     * cannot read somebody's bucket and a console cannot ask.
     *
     * Without it the console could not tell "this bucket still needs the
     * update" from "it ran last week", so the offer to run it was answered by
     * a flag on one device: it came back on the next browser, the next phone,
     * and after clearing site data, however many times it had already been
     * run. Absent means nobody has run it *through us* — the honest answer for
     * a bucket we have never migrated, and the one state that still offers.
     *
     * Six words, the migration's own (`apps/mcp/src/storageLayout.js`), rather
     * than a boolean: `copying` and `cleaning` are under way, `copied` is
     * waiting out the rollback window, `conflict` needs somebody, and
     * `unsupported` is a bucket without conflict-safe writes, which no amount
     * of pressing will change.
     *
     * Metadata about our own plumbing. No key names, no note content.
     */
    storageLayoutState: v.optional(storageLayoutStateValidator),
    storageLayoutAt: v.optional(v.number()),
    /**
     * WHEN WE LAST *LOOKED*, WHICH IS NOT WHEN WE LAST HEARD.
     *
     * `storageLayoutState` absent was originally read as "nobody has run the
     * migration". It never meant that. It meant **nobody has looked** — and
     * for every context migrated before that field existed, those are opposite
     * answers: the bucket's own state under `.context/` said `complete` while
     * this row said nothing, so the console went on offering an update that
     * had already run, on every device, exactly as it had before the field was
     * added. The owner who reported the original nag was still being nagged.
     *
     * So the absence is split in two. This timestamp is set whenever the
     * bucket answered — by `readStorageLayout`, which runs nothing, or by any
     * pass of the migration itself — including when the answer was "there is
     * no migration state here". `storageLayoutState` stays what the bucket
     * *said*, absent when it has genuinely never run.
     *
     * Set means the question has been asked. Absent means it has not, and is
     * the only state the console still offers in.
     *
     * Cleared by a rebind with the state it qualifies: a new bucket has not
     * been looked at either, and carrying "checked" onto it would silently
     * strand it on the old layout with nothing on any screen saying so.
     */
    storageLayoutCheckedAt: v.optional(v.number()),
    /**
     * WHICH GENERATION OF THE QUESTION PRODUCED THAT ANSWER.
     *
     * The timestamp above spends the question for ever: asked once, never
     * asked again. That is right for a question whose answer cannot change,
     * and wrong for one we asked badly — and the first probe asked badly. It
     * looked only for a migration state file, so a bucket **we scaffolded
     * ourselves**, born on the v1 layout and never in its life the owner of a
     * pre-v1 object, answered "nobody has run the migration" — and every
     * newly created workspace was offered a one-time update with nothing
     * behind it, on its first console load.
     *
     * A better probe does not rewrite the rows the old one wrote, and those
     * rows are exactly the new workspaces the bug was about. So the generation
     * is recorded beside the answer: a row from an older one is asked once
     * more by the next console that opens, and nothing has to be backfilled by
     * hand — least of all in a self-hosted deployment nobody here can reach.
     *
     * Only ever consulted for a binding with no recorded `storageLayoutState`.
     * A state is the bucket's own word, and every generation reads that the
     * same way. `functions/lib/storageLayout.ts` holds the number and the
     * predicate.
     */
    storageLayoutCheckedVersion: v.optional(v.number()),
    boundBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),
};
