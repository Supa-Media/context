/**
 * The file editor's data path.
 *
 * This is what lets a person actually *edit their context* from the console —
 * create, rename, move, duplicate, copy, archive, delete, and change what a
 * note is visible to — instead of opening Obsidian to do it.
 *
 * ## Where the bytes live, and where they do not
 *
 * Note content lives in the customer's bucket and nowhere else. It travels
 * through an action and is returned to the caller; it is **never** written to
 * a table, an audit `details` field, a log line, or an error message. That is
 * CLAUDE.md non-negotiable #1, and `__tests__/fileContent.test.ts` asserts it
 * behaviourally across every operation rather than trusting this paragraph.
 *
 * What *is* recorded is the audit trail: which identity did what, to which
 * paths. Paths are metadata. Content is not.
 *
 * ## The credential barrier
 *
 * There is exactly one new function in this codebase that can obtain a
 * decrypted bucket credential: `runFileOperation`. It is an `internalAction`,
 * so no client can reach it. It opens the credential, builds one `S3Store`,
 * hands that store to `lib/fileOps.ts`, and returns a **result** — a listing, a
 * note, an etag. It never returns the credential, never puts it in an error,
 * and never stores it.
 *
 * The public actions below call it. That is a real change to the property
 * `__tests__/structure.test.ts` enforces — previously *no* public function
 * could transitively reach the decrypt path at all — and it is made
 * deliberately, with the guard strengthened rather than loosened around it:
 *
 *  - the set of "barrier" functions is enumerated and pinned in that test, so
 *    adding a second one is a visible, reviewed change, not an accident;
 *  - a public function may reach the decrypt path **only** through a barrier.
 *    Calling `getBindingForGateway` directly is still a hard failure, which is
 *    exactly the attack that test was written around;
 *  - the analyzer now also treats a module-level `internal.…` reference as
 *    tainting the whole module, closing the "hide the call in a helper above
 *    the first export" hole that would otherwise make the barrier optional.
 *
 * Read the block comment in `structure.test.ts` before adding a barrier.
 *
 * ## Authorization
 *
 * Every operation resolves the caller's membership through the same
 * `requireWorkspaceAccess` / `requireWorkspaceRole` the rest of the control
 * plane uses. Reading needs `member`; writing needs `editor` or `owner`. A
 * non-member gets `WORKSPACE_NOT_FOUND` — the same error as for a workspace
 * that never existed.
 *
 * ## Visibility
 *
 * The caller's *scope* comes from their role, and it is deliberately strict:
 *
 *   owner  → `private` scope — sees everything, including private notes
 *   editor → `team` scope
 *   member → `team` scope
 *
 * `private` means "only you" (CLAUDE.md #5). Anyone who is in your workspace
 * because you put them there is, by definition, "named people you granted
 * access to" — which is `team`. Being able to *write* is a separate grant from
 * being able to see what you marked private, and conflating them is how an
 * editor invited to help with one project ends up reading a private folder.
 *
 * This is a product decision as much as a technical one; it is called out in
 * the build report.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import {
  type ActionCtx,
  type QueryCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { inventoryPlugins } from "../../mcp/src/plugins/inventory.js";
// The gateway's D1 wire, imported rather than ported, for the same reason
// `lib/fileOps.ts` imports its search: `apps/mcp` targets the Workers runtime,
// which is Convex's runtime too. It holds the write token for the life of one
// call and puts it in exactly one place, an `Authorization` header.
import { createD1Client } from "../../mcp/src/search/d1/client.js";
/*
 * The Gmail pipeline, imported rather than ported, for exactly the reason the
 * two imports above are: `apps/mcp` targets the Workers runtime, which is
 * Convex's runtime too, and this module takes its socket, its access token and
 * its store as parameters — it opens nothing itself.
 *
 * It came back with the forward sync loop. #388 removed the historical
 * backfill that used to import it and left the module reachable from nothing
 * at all, which is how a complete, fixture-tested mail pipeline sat in the
 * repository while connected mailboxes synced nothing.
 */
import {
  getProfileHistoryId,
  GmailApiError,
  runIncrementalSync,
  writeContactDraft,
  writeDayPart,
} from "../../mcp/src/communications/gmailSync.js";
import {
  ChatApiError,
  listMessagesPage,
  listSpacesPage,
} from "../../mcp/src/communications/googleChat/client.js";
import {
  ChatPaginationError,
  renderSharedGoogleChat,
  syncGoogleChat,
} from "../../mcp/src/communications/googleChat/sync.js";
import {
  ChatContributionConflictError,
  ChatContributionIncompleteError,
  loadActiveChatContributions,
  persistChatContribution,
} from "../../mcp/src/communications/googleChat/contributionStore.js";
import {
  CalendarApiError,
  CalendarPaginationError,
} from "../../mcp/src/communications/calendar-google.js";
import { syncCalendarAccount } from "../../mcp/src/communications/calendar-sync.js";
import {
  CalendarContributionConflictError,
  CalendarContributionIncompleteError,
  loadActiveCalendarContributions,
  loadCalendarContribution,
  persistCalendarContribution,
} from "../../mcp/src/communications/calendarContributionStore.js";
import {
  calendarDayNotePath,
  isCalendarDayNote,
  mergeEventCaches,
  projectDay,
  renderCalendarDay,
} from "../../../packages/communications/src/calendar/index.js";
import { fnv1a64 } from "../../../packages/communications/src/anchors.js";
import {
  D1_ACCOUNT_SECRET,
  D1_TOKEN_SECRET,
  messageFor,
} from "./lib/d1";
import { PROJECTION_CHAIN } from "./lib/fastSearch";
import {
  type BlendSource,
  decodeCursor,
  depthFor,
  encodeCursor,
  fuse,
  pageOf,
  queryFingerprint,
  resolveScope,
} from "./lib/blendedSearch";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  clearVaultBatch,
  archivePath,
  copyPath,
  createFolder,
  deletePath,
  duplicatePath,
  listFolder,
  movePath,
  readFile,
  maintainSearchIndex,
  notePathIndex,
  projectSearchIndex,
  type ProjectionClient,
  type ProjectionPass,
  searchNotes,
  type SearchResults,
  removeNoteEncryption as removeNoteEncryptionOp,
  resetPrivacyManifest,
  setFolderVisibility,
  setVisibility,
  writeFile,
  importVaultFiles,
  writeImage,
  readImage,
} from "./lib/fileOps";
import { PRIVACY_KEY, type Scope, type Visibility } from "./lib/privacy";
import {
  ensureFormResponseFiles,
  runFormAction,
  type FormAction,
  type FormResult,
  type FormSeedResult,
} from "./lib/formOps";
import {
  type WorkspaceRole,
  requireWorkspaceAccess,
  requireWorkspaceRole,
} from "./lib/workspaceAuth";
import type { GatewayCredential } from "./storage";

/** Same deadline `functions/provisioning.ts` puts on the customer's endpoint. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Maintenance passes that may chain behind one search's worth of work.
 *
 * A brain of a few thousand notes does not index in one pass, and the
 * alternative to chaining is what the project note calls out as still open:
 * "the complete backfill finishes without requiring repeated user searches".
 * Making somebody search eight times to finish their own index is making them
 * do the system's work.
 *
 * Each link is scheduled only by a pass that **made progress and did not
 * finish**, so a converged bucket stops at one and a bucket that cannot
 * converge — an unreadable folder, a shard that will not fit — stops as soon
 * as it stops changing rather than looping on the customer's request quota.
 * The bound is the backstop for the case both of those miss.
 */
const INDEX_SYNC_CHAIN = 12;

/**
 * What a projection link answers when there is nothing for it to do.
 *
 * A row that stopped being `backfilling`, an owner who opted out, a deployment
 * with no D1 credential. Zeros and `moved: false`, which is what ends the
 * chain — and `report: false`, because writing these onto a row would say a
 * backfill found no notes rather than that no backfill ran.
 */
const IDLE_PROJECTION = {
  kind: "indexProjected",
  projected: 0,
  deleted: 0,
  notesIndexed: 0,
  notesPending: 0,
  ready: false,
  moved: false,
  report: false,
} as const;

export { DELETE_CONFIRMATION };

/* -------------------------------------------------------------------------- */
/*                                 validators                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a console caller may ASK for. Two-valued, and it stays that way.
 *
 * A rule naming a group reaches `privacy.md` from the console's own group
 * controls or a person's editor — never from `setNoteVisibility` or
 * `setFolderVisibility`, whose whole job is the two tiers. Widening this
 * would make every path that takes a visibility a way to mint a rule, which
 * is the opposite of the gateway's position that no AI client can.
 */
const visibilityValidator = v.union(v.literal("private"), v.literal("team"));

/**
 * What a visibility may be on the way OUT.
 *
 * `v.string()` rather than the two literals, because a rule may name a group
 * and a bucket can already hold one. The narrow validator did not merely
 * mislabel such a note — it **threw at the boundary**, so one hand-edited rule
 * took the whole console listing down. What a group name may contain is
 * enforced where it is parsed (`GROUP_SCOPE_PATTERN` in `lib/privacy.ts`),
 * which fails the manifest closed rather than per response; there is nothing
 * left for this validator to check that the parser has not.
 */
const visibilityReadValidator = v.string();

const entryValidator = v.object({
  kind: v.union(v.literal("file"), v.literal("folder")),
  path: v.string(),
  name: v.string(),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
  size: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
});

const listingValidator = v.object({
  kind: v.literal("listing"),
  path: v.string(),
  folderDefault: visibilityReadValidator,
  entries: v.array(entryValidator),
  truncated: v.boolean(),
  manifestUsable: v.boolean(),
});

const imageWrittenValidator = v.object({
  kind: v.literal("imageWritten"),
  key: v.string(),
  etag: v.string(),
});

const imageValidator = v.object({
  kind: v.literal("image"),
  bytes: v.bytes(),
});

const pluginVerdictValidator = v.union(
  v.literal("runs"),
  v.literal("needs-approval"),
  v.literal("files-only"),
  v.literal("wont-run"),
  v.literal("unknown"),
);

const pluginEvidenceValidator = v.object({
  id: v.string(),
  kind: v.union(
    v.literal("module"),
    v.literal("member"),
    v.literal("network"),
    v.literal("dynamic"),
    v.literal("scan"),
  ),
  reason: v.string(),
});

const pluginValidator = v.object({
  folder: v.string(),
  id: v.string(),
  name: v.string(),
  version: v.string(),
  author: v.string(),
  description: v.string(),
  bundleFingerprint: v.union(v.string(), v.null()),
  isDesktopOnly: v.boolean(),
  manifestError: v.union(v.string(), v.null()),
  verdict: pluginVerdictValidator,
  evidence: v.array(pluginEvidenceValidator),
  notes: v.array(v.string()),
  limitations: v.array(v.string()),
  hosts: v.array(v.string()),
  reason: v.string(),
  supported: v.array(v.string()),
});

const pluginInventoryValidator = v.object({
  kind: v.literal("pluginInventory"),
  available: v.boolean(),
  reason: v.union(v.string(), v.null()),
  plugins: v.array(pluginValidator),
  counts: v.object({
    runs: v.number(),
    "needs-approval": v.number(),
    "files-only": v.number(),
    "wont-run": v.number(),
    unknown: v.number(),
  }),
  found: v.number(),
  scanned: v.number(),
  truncated: v.boolean(),
  checkedAt: v.string(),
});

type PluginVerdict = "runs" | "needs-approval" | "files-only" | "wont-run" | "unknown";
type PluginInventory = {
  available: boolean;
  reason: string | null;
  plugins: Array<{
    folder: string;
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    bundleFingerprint: string | null;
    isDesktopOnly: boolean;
    manifestError: string | null;
    verdict: PluginVerdict;
    evidence: Array<{
      id: string;
      kind: "module" | "member" | "network" | "dynamic" | "scan";
      reason: string;
    }>;
    notes: string[];
    limitations: string[];
    hosts: string[];
    reason: string;
    supported: string[];
  }>;
  counts: Record<PluginVerdict, number>;
  found: number;
  scanned: number;
  truncated: boolean;
  checkedAt: string;
};

const vaultImportResultValidator = v.object({
  kind: v.literal("vaultImported"),
  created: v.array(v.string()),
  skipped: v.array(v.string()),
  bytesCreated: v.number(),
});

const vaultClearResultValidator = v.object({
  kind: v.literal("vaultCleared"),
  mode: v.union(v.literal("counted"), v.literal("deleted")),
  objects: v.number(),
  complete: v.boolean(),
});

const replacementStatusValidator = v.object({
  phase: v.union(v.literal("counting"), v.literal("deleting"), v.literal("uploading")),
  totalObjects: v.number(),
  deletedObjects: v.number(),
});

const vaultImportJobStatusValidator = v.object({
  jobId: v.id("vaultImportJobs"),
  strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
  status: v.union(v.literal("active"), v.literal("paused"), v.literal("complete")),
  totalFiles: v.number(),
  completedFiles: v.number(),
  createdFiles: v.number(),
  skippedFiles: v.number(),
  completedBatches: v.array(v.number()),
  replacement: v.optional(replacementStatusValidator),
});

const fileValidator = v.object({
  kind: v.literal("file"),
  path: v.string(),
  text: v.string(),
  etag: v.string(),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
  /**
   * The note is stored encrypted and `text` is its ciphertext.
   *
   * `readOnly` is already true whenever this is, so a console that predates the
   * field still refuses to edit one — the flag adds the *explanation*, not the
   * protection. See `docs/decisions/encryption.md`.
   */
  encrypted: v.boolean(),
});

/**
 * What a form block's response files did on this write.
 *
 * Two lists of paths and reasons — never a body, never an etag of somebody
 * else's note. It is reported back to the author because a `responses:` aimed
 * at a file that already holds something is a form that will silently collect
 * nothing, and they are the only person who can re-aim it.
 */
const formSeedValidator = v.object({
  created: v.array(v.string()),
  occupied: v.array(v.string()),
});

const writtenValidator = v.object({
  kind: v.literal("written"),
  path: v.string(),
  etag: v.string(),
  conflictCheck: v.union(v.literal("conditional"), v.literal("read-compare")),
  forms: formSeedValidator,
});

const movedValidator = v.object({
  kind: v.literal("moved"),
  from: v.string(),
  to: v.string(),
  paths: v.array(v.string()),
  /**
   * What the link rewrite did, and **optional on purpose**.
   *
   * `copyPath` shares this validator and rewrites nothing — a copy leaves every
   * original where it was, so there is no reference to follow — and a move that
   * found nothing to do reports zeroes rather than omitting the field. Required
   * would force `copyEntry` to invent a shape describing work it never does.
   */
  references: v.optional(
    v.object({ notes: v.number(), links: v.number(), capped: v.boolean() }),
  ),
});

const deletedValidator = v.object({
  kind: v.literal("deleted"),
  paths: v.array(v.string()),
});

const visibilityResultValidator = v.object({
  kind: v.literal("visibility"),
  path: v.string(),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
});

const folderCreatedValidator = v.object({
  kind: v.literal("folderCreated"),
  path: v.string(),
  readme: v.string(),
});

const privacyResetValidator = v.object({
  kind: v.literal("privacyReset"),
  path: v.string(),
  folders: v.array(v.string()),
  /**
   * A `.context/recover/` key, and the one place the console is told one.
   *
   * Shown because "we replaced your file" and "we replaced your file and here
   * is where the old one went" are different sentences to somebody whose
   * manifest had forty rules in it. This is the only copy this product still
   * keeps of anything: `.history/` snapshots are gone, and versioning is the
   * customer's to enable at their provider.
   */
  backedUpTo: v.union(v.string(), v.null()),
  /** `folders` is short: the walk hit its cap, or a name could not be a rule. */
  partial: v.boolean(),
});

const searchResultsValidator = v.object({
  kind: v.literal("searchResults"),
  hits: v.array(
    v.object({ path: v.string(), title: v.string(), snippets: v.array(v.string()) }),
  ),
  matchCount: v.number(),
  matchCountIsFloor: v.boolean(),
  indexIncomplete: v.boolean(),
  /**
   * Nothing has indexed this bucket yet. Distinct from "no matches" on
   * purpose — see `searchNotes` in `lib/fileOps.ts` on why collapsing the two
   * would tell somebody their note does not exist.
   */
  indexMissing: v.boolean(),
  /**
   * Some of this caller's own visible notes lost per-message recall to the
   * search index's own capacity, and never resolves by searching again —
   * `indexIncomplete`'s opposite claim, which is why it is a field of its own
   * rather than folded in (`docs/decisions/search.md`, sizing section).
   */
  reducedRecall: v.boolean(),
  /** Which of the caller's own visible notes those are — already `canSee`-filtered. */
  reducedRecallNotes: v.array(v.string()),
});

/**
 * `null` means the search index has nothing to answer link resolution from
 * yet — not "this bucket has no notes". See `notePathIndex` in
 * `lib/fileOps.ts`.
 */
const notePathsValidator = v.object({
  kind: v.literal("notePaths"),
  paths: v.union(v.array(v.string()), v.null()),
});

/**
 * One blended answer: a page of results, and one row per context it asked.
 *
 * Every count in here is taken **after** the caller's own `canSee` — in
 * `searchNotes`, which is where the single-context answer takes it too. A
 * blended total assembled from candidate counts would be the subtraction attack
 * `search/CONTRACT.md` names, run once per context and then summed, which is
 * strictly worse than running it once: the differences would tell a member
 * which of several contexts holds the notes they cannot read.
 */
const blendedResultsValidator = v.object({
  results: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      path: v.string(),
      title: v.string(),
      /** The explanatory line, or `""` where the index had none to give. */
      snippet: v.string(),
    }),
  ),
  /** Visible matches across every context asked. A floor when any source's is. */
  matchCount: v.number(),
  matchCountIsFloor: v.boolean(),
  /** Opaque, and `null` when there is no next page. Never carries the query. */
  cursor: v.union(v.string(), v.null()),
  /**
   * One row per context searched — the scope, as the server resolved it.
   *
   * This is what makes a partial failure useful rather than invisible: a source
   * that timed out is a row saying so beside the results from the sources that
   * answered, and retrying it is the same call with that one id in `contexts`.
   */
  sources: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      state: v.union(v.literal("ok"), v.literal("indexing"), v.literal("failed")),
      matchCount: v.number(),
      matchCountIsFloor: v.boolean(),
    }),
  ),
  /**
   * How many contexts this viewer could search at all, whatever they selected.
   *
   * Zero is its own state on screen — "you are not in a context yet" is a
   * different sentence from "nothing matched", and collapsing them would tell
   * somebody their notes are not there when nothing looked.
   */
  searchableCount: v.number(),
});

/**
 * What one maintenance pass got through. Counts about the index's own
 * progress, and deliberately nothing about the notes it read: an indexing pass
 * is scope-blind, so a field naming a path or a term here would be an
 * existence oracle for the private half of somebody's bucket.
 *
 * `shed` and `oversizedShards` are `pending`'s own opposite in the same
 * shape: a whole-bucket scalar, never a path (`docs/decisions/search.md`,
 * sizing section — `syncShardedIndex`'s `shed`/`oversizedShards`, which no
 * caller of this reply read before). Where they DO name a path is
 * `searchResultsValidator.reducedRecallNotes`, which is safe because it is
 * already filtered through one caller's own `canSee` — this reply, like every
 * other field above, is not.
 */
const indexMaintainedValidator = v.object({
  kind: v.literal("indexMaintained"),
  pending: v.number(),
  changed: v.boolean(),
  complete: v.boolean(),
  shed: v.number(),
  oversizedShards: v.number(),
});

/**
 * What one projection pass reports back, and nothing else.
 *
 * Counts, a state and a failure code. **No path, no title and no term** — the
 * pass reads every note in the bucket including private ones, and a return
 * that could name which ones it touched would be an existence oracle for the
 * private half of somebody's context, which is the same rule
 * `indexMaintained` follows one field at a time.
 *
 * `failure` is a `D1Error` code from a closed set, never a provider sentence.
 */
const indexProjectedValidator = v.object({
  kind: v.literal("indexProjected"),
  projected: v.number(),
  deleted: v.number(),
  notesIndexed: v.number(),
  notesPending: v.number(),
  ready: v.boolean(),
  moved: v.boolean(),
  report: v.boolean(),
  failure: v.optional(v.string()),
});

const googleSyncRunValidator = v.object({
  kind: v.literal("googleSyncRun"),
  runId: v.id("googleSyncRuns"),
  status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
  totalUnits: v.number(),
  completedUnits: v.number(),
  itemsFound: v.number(),
  daysWithMail: v.number(),
  bytesWritten: v.number(),
  continue: v.boolean(),
});

/**
 * One forward sync pass, as the scheduler sees it. No mail, no path, no
 * cursor — the cursor is written to the connection row by
 * `recordGoogleForwardSyncPass`, and a scheduled action's return value is read
 * by nobody but a test.
 */
const googleForwardSyncValidator = v.object({
  kind: v.literal("googleForwardSync"),
  connectionId: v.id("googleConnections"),
  status: v.union(v.literal("synced"), v.literal("skipped"), v.literal("failed")),
  daysTouched: v.number(),
  bytesWritten: v.number(),
  cursorAdvanced: v.boolean(),
  gapDetected: v.boolean(),
  /** The history walk ran out of pages; this connection has more to drain. */
  truncated: v.boolean(),
  errorCode: v.optional(v.string()),
});

/**
 * One answer to one field.
 *
 * A list of pairs rather than an object keyed by field name, because a form's
 * fields are the author's and a Convex validator — like the gateway's tool
 * schema — cannot close an object whose keys it does not know. An open one at
 * this position accepts whatever a caller puts there, which is the hole both
 * validators exist to shut.
 */
const formAnswerValidator = v.object({ field: v.string(), value: v.string() });

const formResultValidator = v.object({
  kind: v.literal("formApplied"),
  responseId: v.string(),
  formId: v.string(),
  responsesPath: v.string(),
  votes: v.optional(v.number()),
});

const operationResultValidator = v.union(
  listingValidator,
  fileValidator,
  writtenValidator,
  movedValidator,
  deletedValidator,
  visibilityResultValidator,
  folderCreatedValidator,
  privacyResetValidator,
  imageWrittenValidator,
  imageValidator,
  pluginInventoryValidator,
  vaultImportResultValidator,
  vaultClearResultValidator,
  searchResultsValidator,
  notePathsValidator,
  indexMaintainedValidator,
  indexProjectedValidator,
  googleSyncRunValidator,
  googleForwardSyncValidator,
  formResultValidator,
);

const operationValidator = v.union(
  v.object({ kind: v.literal("list"), path: v.string() }),
  v.object({ kind: v.literal("read"), path: v.string() }),
  v.object({
    kind: v.literal("search"),
    query: v.string(),
    prefix: v.optional(v.string()),
    /**
     * How far down the ranked list this answer reads. Absent is ten, the
     * palette's depth; the search page's later pages ask for more. Clamped by
     * `pageDepth` below this, at `MAX_RESULTS` — the rank the ranker stops at.
     */
    limit: v.optional(v.number()),
    /**
     * Whether a miss may buy one bucket listing and ask again. Absent is true,
     * which is what a single-context search has always done. The fan-out sets
     * it false; `searchNotes` carries the arithmetic for why.
     */
    refreshOnMiss: v.optional(v.boolean()),
  }),
  /**
   * Every note path this scope may see, for the editor's link resolution.
   * See `notePathIndex` in `lib/fileOps.ts` and "L1" in
   * `docs/decisions/app-and-console.md`.
   */
  v.object({ kind: v.literal("notePaths") }),
  /**
   * Bring the search index a pass further. Scheduled, never called by a client
   * — there is no public action that reaches this variant.
   *
   * `passes` is how many *more* passes may be chained behind this one when it
   * makes progress and does not finish. A cold brain needs several, and
   * requiring a person to search repeatedly to finish their own backfill is
   * the acceptance criterion this closes; the bound is what stops a bucket
   * that never converges from scheduling itself forever.
   */
  v.object({ kind: v.literal("maintainIndex"), passes: v.optional(v.number()) }),
  /**
   * Copy a pass's worth of this context's notes into its search database.
   * Scheduled, never called by a client — there is no public action that
   * reaches this variant either.
   *
   * `passes` is the same bound `maintainIndex` carries and the same backstop:
   * what actually ends the chain is a pass that moved nothing, a row that
   * stopped being `backfilling`, or a projection that reached `ready`.
   */
  v.object({ kind: v.literal("projectIndex"), passes: v.optional(v.number()) }),
  v.object({ kind: v.literal("googleGmailBackfill"), runId: v.id("googleSyncRuns") }),
  /**
   * Advance one connected Google account from its own cursor. Scheduled by
   * `googleSync.sweepDueGoogleSyncs` and by nothing else — there is no public
   * action that reaches this variant, and no argument on it a caller could use
   * to name a context: the workspace comes from the connection row.
   */
  v.object({ kind: v.literal("googleForwardSync"), connectionId: v.id("googleConnections") }),
  v.object({
    kind: v.literal("write"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("importVault"),
    files: v.array(v.object({
      path: v.string(),
      bytes: v.bytes(),
      contentType: v.string(),
    })),
  }),
  v.object({ kind: v.literal("clearVault"), countOnly: v.boolean() }),
  v.object({ kind: v.literal("ensurePrivacy") }),
  v.object({
    kind: v.literal("removeEncryption"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("createFolder"), path: v.string() }),
  /**
   * Bytes into the opaque store, and back out again.
   *
   * Deliberately not `write`/`read` with a flag. Those carry a path and consult
   * `privacy.md`; these carry a *leaf* and must not, because an object under
   * `.context/assets/images/` has no visibility of its own — it borrows the visibility of
   * whatever note references it. Sharing the variant would mean sharing the
   * question, and the manifest has no answer for a key it does not describe.
   */
  v.object({
    kind: v.literal("writeImage"),
    leaf: v.string(),
    bytes: v.bytes(),
    contentType: v.string(),
  }),
  v.object({ kind: v.literal("readImage"), leaf: v.string() }),
  v.object({ kind: v.literal("pluginInventory") }),
  v.object({ kind: v.literal("move"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("copy"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("duplicate"), path: v.string() }),
  v.object({ kind: v.literal("archive"), path: v.string() }),
  v.object({
    kind: v.literal("delete"),
    path: v.string(),
    confirmation: v.string(),
  }),
  v.object({
    kind: v.literal("setVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
  }),
  v.object({
    kind: v.literal("setNoteGroup"),
    path: v.string(),
    /**
     * The group's full name WITHOUT the `@`, already proven to belong to this
     * workspace by `setNoteGroup` before the operation is dispatched. A plain
     * string here rather than a group id: this is the value that lands in
     * `privacy.md`, and the manifest holds names, not ids.
     */
    group: v.string(),
  }),
  v.object({
    kind: v.literal("setFolderVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
  }),
  v.object({
    /**
     * One markdown form action. See `lib/formOps.ts` for why this is a file
     * operation rather than a second place that opens a bucket credential.
     */
    kind: v.literal("form"),
    path: v.string(),
    formId: v.optional(v.string()),
    actorName: v.string(),
    actorRole: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    action: v.union(
      v.object({ kind: v.literal("submit"), values: v.array(formAnswerValidator) }),
      v.object({
        kind: v.literal("update"),
        responseId: v.string(),
        values: v.array(formAnswerValidator),
      }),
      v.object({ kind: v.literal("retract"), responseId: v.string() }),
      v.object({
        kind: v.literal("vote"),
        responseId: v.string(),
        vote: v.union(v.literal("up"), v.literal("none")),
      }),
    ),
  }),
  v.object({ kind: v.literal("resetPrivacy") }),
);

type FileOperation =
  | { kind: "list"; path: string }
  | { kind: "read"; path: string }
  | {
      kind: "search";
      query: string;
      prefix?: string;
      limit?: number;
      refreshOnMiss?: boolean;
    }
  | { kind: "notePaths" }
  | { kind: "maintainIndex"; passes?: number }
  | { kind: "projectIndex"; passes?: number }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | {
      kind: "importVault";
      files: Array<{ path: string; bytes: ArrayBuffer; contentType: string }>;
    }
  | { kind: "clearVault"; countOnly: boolean }
  | { kind: "ensurePrivacy" }
  /**
   * Replace an encrypted note's content with plaintext. A separate operation
   * from `write` rather than one more of its shapes — `writeFile` never
   * accepts plaintext over an encrypted note, and this is the one narrow,
   * explicit door that does. See `removeNoteEncryption` in `lib/fileOps.ts`.
   */
  | { kind: "removeEncryption"; path: string; text: string; expectedEtag?: string }
  | { kind: "createFolder"; path: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "duplicate"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; confirmation: string }
  | { kind: "setVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "setNoteGroup"; path: string; group: string }
  | { kind: "setFolderVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "writeImage"; leaf: string; bytes: ArrayBuffer; contentType: string }
  | { kind: "readImage"; leaf: string }
  | { kind: "pluginInventory" }
  | {
      kind: "form";
      path: string;
      formId?: string;
      actorName: string;
      actorRole: WorkspaceRole;
      action: FormAction;
    }
  | { kind: "resetPrivacy" };

/**
 * What a file operation hands back to the console.
 *
 * `visibility`, `inherited` and `folderDefault` are `Visibility` rather than
 * the two literals they used to be: a rule may name a group, and typing these
 * narrowly meant the control plane silently re-tiered one on the way out —
 * which is the same class of bug as the gateway writing `"private"` over a
 * group rule on a move. The console renders the extra case explicitly; see
 * `features/console/privacy/words.ts`.
 */
type OperationResult =
  | ({ kind: "formApplied" } & FormResult)
  | ({ kind: "searchResults" } & SearchResults)
  | ({ kind: "pluginInventory" } & PluginInventory)
  | { kind: "notePaths"; paths: string[] | null }
  | {
      kind: "indexMaintained";
      pending: number;
      changed: boolean;
      complete: boolean;
      shed: number;
      oversizedShards: number;
    }
  | ({ kind: "indexProjected" } & Omit<ProjectionPass, "failure"> & { failure?: string })
  | {
      kind: "googleSyncRun";
      runId: Id<"googleSyncRuns">;
      status: "running" | "complete" | "failed";
      totalUnits: number;
      completedUnits: number;
      itemsFound: number;
      daysWithMail: number;
      bytesWritten: number;
      continue: boolean;
    }
  | {
      kind: "googleForwardSync";
      connectionId: Id<"googleConnections">;
      status: "synced" | "skipped" | "failed";
      daysTouched: number;
      bytesWritten: number;
      cursorAdvanced: boolean;
      gapDetected: boolean;
      truncated: boolean;
      errorCode?: string;
    }
  | { kind: "vaultImported"; created: string[]; skipped: string[]; bytesCreated: number }
  | { kind: "vaultCleared"; mode: "counted" | "deleted"; objects: number; complete: boolean }
  | {
      kind: "listing";
      path: string;
      folderDefault: Visibility;
      entries: Array<{
        kind: "file" | "folder";
        path: string;
        name: string;
        visibility: Visibility;
        inherited: Visibility;
        exception: boolean;
        readOnly: boolean;
        size?: number;
        updatedAt?: number;
      }>;
      truncated: boolean;
      manifestUsable: boolean;
    }
  | {
      kind: "file";
      path: string;
      text: string;
      etag: string;
      visibility: Visibility;
      inherited: Visibility;
      exception: boolean;
      readOnly: boolean;
      /** Stored encrypted; `text` is the ciphertext and the note is not editable here. */
      encrypted: boolean;
    }
  | {
      kind: "written";
      path: string;
      etag: string;
      conflictCheck: "conditional" | "read-compare";
      /**
       * Response files this write created for form blocks on the note, and
       * forms whose `responses:` points somewhere unusable.
       *
       * Reported to the author rather than kept quiet, for the reason
       * `ensureFormResponseFiles` gives: a `responses:` aimed at an existing
       * note is a form that will never collect anything, and the only person
       * who can fix it is the one who just saved the block.
       */
      forms: FormSeedResult;
    }
  | { kind: "moved"; from: string; to: string; paths: string[] }
  | { kind: "deleted"; paths: string[] }
  | {
      kind: "visibility";
      path: string;
      visibility: Visibility;
      inherited: Visibility;
      exception: boolean;
    }
  | { kind: "folderCreated"; path: string; readme: string }
  | {
      kind: "privacyReset";
      path: string;
      folders: string[];
      backedUpTo: string | null;
      partial: boolean;
    }
  | { kind: "imageWritten"; key: string; etag: string }
  | { kind: "image"; bytes: ArrayBuffer };

/* -------------------------------------------------------------------------- */
/*                               authorization                                */
/* -------------------------------------------------------------------------- */

/**
 * A role's visibility clearance. See the module comment for why an `editor`
 * gets `team` rather than `private`.
 */
export function scopeForRole(role: WorkspaceRole): Scope {
  return role === "owner" ? "private" : "team";
}

/**
 * Resolve membership and clearance.
 *
 * INTERNAL. `actorUserId` is supplied by the calling public action, which read
 * it from the session — the same arrangement `storage.applyBinding` uses, and
 * safe for the same reason: an internal function is unreachable from any
 * client, so there is nobody who could pass a forged one.
 */
export const authorizeFileAccess = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    minimum: v.union(v.literal("member"), v.literal("editor"), v.literal("owner")),
  },
  returns: v.object({
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    scope: v.union(v.literal("private"), v.literal("team")),
  }),
  handler: async (ctx, args) => {
    const access =
      args.minimum === "member"
        ? await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId)
        : await requireWorkspaceRole(
            ctx,
            args.workspaceId,
            args.actorUserId,
            args.minimum,
          );
    return {
      role: access.membership.role,
      scope: scopeForRole(access.membership.role),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*                            the credential barrier                          */
/* -------------------------------------------------------------------------- */

/**
 * THE CREDENTIAL BARRIER. Read the module comment before changing this.
 *
 * The only function added by the file editor that opens a bucket credential.
 * It builds one store, performs one operation, and returns a result that by
 * construction contains no credential: `operationResultValidator` has no field
 * that could hold one, and Convex enforces that validator on the way out.
 *
 * INTERNAL ACTION, so no client can call it. Its callers are the public
 * actions below, each of which has already established that the caller is a
 * member of this workspace with a sufficient role.
 */
export const runFileOperation = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    scope: v.union(v.literal("private"), v.literal("team")),
    operation: operationValidator,
  },
  returns: operationResultValidator,
  // Annotated rather than inferred: this action calls another function in the
  // same deployment, which is the inference cycle `bindStorage` has.
  handler: async (ctx, args): Promise<OperationResult> => {
    /*
     * A PROJECTION PASS ASKS THE ROW BEFORE IT ASKS FOR A CREDENTIAL.
     *
     * This link may have been scheduled minutes ago by a chain, a provisioner,
     * or the sweep, and in that time an owner can have turned fast search off.
     * A pass that opened the bucket first and then discovered it had nothing
     * to do would have decrypted a customer's storage secret on the way to
     * doing nothing — so the order here is the guard. The test that pins it
     * deletes the storage binding, because "no bucket request was made" cannot
     * see the mutant: opening a credential makes none.
     *
     * `projectionTargetForWorkspace` is the same composed gate that decides
     * whether a D1 write credential may leave this deployment for the gateway,
     * and every reason to say no is the same `null`. `backfilling` and nothing
     * else: a `ready` row is served by the gateway riding its own search's
     * sync, and a chain that kept running against one would be a full bucket
     * listing per link, forever, for a context with nothing left to copy.
     */
    let projection: ProjectionClient | null = null;

    /**
     * This context's search database, if the row is in the state the caller
     * needs and this deployment is configured.
     *
     * Two callers now and they want opposite states, which is the whole reason
     * this is a parameter rather than a constant: a projection pass may only
     * run against a row that is still `backfilling`, and a search may only
     * READ one the control plane has called `ready` — the same gate the
     * gateway applies, because a projection that is still filling answers a
     * query about a note it has not copied with a silence a reader would take
     * for a miss.
     *
     * `null` for every way of saying no, and they are deliberately
     * indistinguishable to the caller: not opted in, not provisioned, wrong
     * state, or a deployment with no Cloudflare credential.
     */
    const projectionTarget = async (required: "backfilling" | "ready") => {
      const target = await ctx.runQuery(
        internal.functions.fastSearch.projectionTargetForWorkspace,
        { workspaceId: args.workspaceId },
      );
      return target === null || target.state !== required ? null : target;
    };

    /**
     * The client for a target the caller has already accepted.
     *
     * Held apart from the lookup above because the two callers do different
     * things with `null` from each: a wrong state is an ordinary no for both,
     * and a missing Cloudflare credential is a reported failure for a pass and
     * a silent fall-through for a search.
     */
    const clientFor = async (
      target: { databaseId: string; state: string },
    ): Promise<ProjectionClient | null> => {
      // Ours, not a customer's — `appSecrets` holds this deployment's own
      // integration credentials.
      const apiToken = await ctx.runAction(
        internal.functions.admin.readIntegrationSecret,
        { name: D1_TOKEN_SECRET },
      );
      const accountId = await ctx.runAction(
        internal.functions.admin.readIntegrationSecret,
        { name: D1_ACCOUNT_SECRET },
      );
      if (
        typeof apiToken !== "string" ||
        apiToken.length === 0 ||
        typeof accountId !== "string" ||
        accountId.length === 0
      ) {
        // Both or neither, as `provisionIndex` reads them: a half-configured
        // deployment is two error states with one cure.
        return null;
      }
      return createD1Client(
        { databaseId: target.databaseId, accountId, apiToken, state: target.state },
        // No `fetchImpl`: the client resolves `globalThis.fetch` per call and
        // carries its own deadline. Handing it `timeoutFetch` would *replace*
        // the abort signal it sets with a longer one, quietly disabling the
        // timeout it thinks it has.
      ) as ProjectionClient;
    };

    /*
     * A SEARCH READS THE PROJECTION AND NEVER WRITES THE ROW.
     *
     * The asymmetry with the pass below is deliberate and is the reason these
     * are two blocks rather than one. A projection pass that cannot reach its
     * database must SAY so — a workspace sitting at "Preparing" with nothing
     * to explain why is the bug that whole path exists to close. A search must
     * do the opposite: somebody typed a word, and a deployment whose
     * Cloudflare credential is missing must not have their search flip a
     * provisioning row to `failed` as a side effect. It falls through to the
     * R2 index, which is what every context without fast search does anyway.
     */
    if (args.operation.kind === "search") {
      const target = await projectionTarget("ready");
      if (target !== null) projection = await clientFor(target);
    }

    if (args.operation.kind === "projectIndex") {
      const target = await projectionTarget("backfilling");
      if (target === null) return IDLE_PROJECTION;

      try {
        projection = await clientFor(target);
        if (projection === null) throw new Error("no D1 credential");
      } catch {
        // A deployment nobody has configured is an ordinary state, and the row
        // has to say so: left `backfilling`, it is a person watching a counter
        // that will never move with nothing to explain why. The thrown error
        // can quote the descriptor it was handed, so it is dropped rather than
        // wrapped.
        await ctx.runMutation(
          internal.functions.fastSearch.recordProvisionResult,
          {
            workspaceId: args.workspaceId,
            status: "failed",
            errorCode: "NOT_CONFIGURED",
            error: messageFor("NOT_CONFIGURED"),
          },
        );
        return IDLE_PROJECTION;
      }
    }

    if (args.operation.kind === "googleGmailBackfill") {
      return await runGoogleGmailBackfill(
        ctx,
        args.workspaceId,
        args.operation.runId,
      );
    }

    /*
     * A FORWARD SYNC PASS ASKS THE ROW BEFORE IT ASKS FOR A CREDENTIAL.
     *
     * Same ordering, same reason, as the projection pass above. The sweep that
     * scheduled this holds no decision and ran minutes ago; in between, the
     * account can have been disconnected, its product turned off, or its grant
     * refused by Google. Asking first means none of those decrypt a customer's
     * storage secret on the way to doing nothing.
     *
     * A `null` job means there is no connection row to report against at all,
     * so there is also no claim to release.
     */
    let forwardSyncJob: ForwardSyncJob = null;
    if (args.operation.kind === "googleForwardSync") {
      forwardSyncJob = await ctx.runQuery(
        internal.functions.googleSync.googleForwardSyncJob,
        { workspaceId: args.workspaceId, connectionId: args.operation.connectionId },
      );
      if (forwardSyncJob === null) {
        /*
         * No row this workspace owns — it was deleted, or the pair of
         * arguments does not agree (see `googleForwardSyncJob`). Nothing is
         * written, and in particular the *other* context's row is not: a
         * mismatched pair that released somebody else's claim and pushed their
         * next sync out would be a cross-tenant write, small but real.
         */
        return {
          kind: "googleForwardSync",
          connectionId: args.operation.connectionId,
          status: "skipped",
          daysTouched: 0,
          bytesWritten: 0,
          cursorAdvanced: false,
          gapDetected: false,
          truncated: false,
        };
      }
      if (forwardSyncJob.kind === "skip") {
        return await releaseForwardSync(
          ctx,
          args.operation.connectionId,
          forwardSyncJob.reason,
        );
      }
    }

    let credential: GatewayCredential | null;
    try {
      credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
        workspaceId: args.workspaceId,
      });
    } catch {
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_UNUSABLE",
          "This context's bucket configuration could not be used. Reconnect storage.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_UNUSABLE",
        message:
          "This context's bucket configuration could not be used. Reconnect storage.",
      });
    }
    if (credential === null) {
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_NOT_CONNECTED",
          "This context has no bucket connected yet. Connect storage before syncing Google.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_NOT_CONNECTED",
        message:
          "This context has no bucket connected yet. Connect storage before browsing files.",
      });
    }

    // A plaintext secret is in scope from here to the end of this function. It
    // is used to construct one store and nothing else — it is not logged, not
    // returned, and not passed to `lib/fileOps.ts`, which only ever sees the
    // store.
    let store: FileStore;
    try {
      // One table decides which backend this workspace got — the same table
      // the gateway uses, so the console reads and writes exactly what an AI
      // client does. A second switch here would be the second place to forget
      // a new backend, and the direction that forgetting fails is "built an
      // S3 store out of a Dropbox binding".
      //
      // `timeoutFetch` is forwarded because a console request has somebody
      // waiting on it; the gateway does not need one.
      //
      // `S3Store` *declares* conditional writes because it sends `If-Match`.
      // Whether the backend honours it is a different question, and it was
      // already answered — at connect time, by `probeStore`, against this
      // actual bucket. Backblaze B2 and Wasabi accept the header and write
      // anyway. Taking the declaration would make every save look conflict-safe
      // on exactly the backends where it is not; the observed capability makes
      // `writeFile` fall back to a read-compare and say so.
      //
      // That used to be applied here, on the next line, by hand — and only
      // here, so the gateway's own stores claimed a guarantee they did not
      // have. `storeForBinding` reads the binding's probed capability itself
      // now, for every caller and every backend.
      store = storeForBinding(credential, undefined, {
        fetchImpl: timeoutFetch,
      }) as unknown as FileStore;
    } catch {
      // The constructor's message can quote the endpoint the customer typed.
      // Nothing it says helps here, and re-throwing it would put provider text
      // in front of the user with no way to know what else is in it.
      if (args.operation.kind === "googleForwardSync") {
        return await failForwardSync(
          ctx,
          args.operation.connectionId,
          "STORAGE_UNUSABLE",
          "This context's bucket configuration could not be used. Reconnect storage.",
        );
      }
      throw new ConvexError({
        code: "STORAGE_UNUSABLE",
        message:
          "This context's bucket configuration could not be used. Reconnect storage.",
      });
    }

    if (args.operation.kind === "googleForwardSync" && forwardSyncJob?.kind === "run") {
      return await runGoogleForwardSync(ctx, store, forwardSyncJob);
    }

    const result = await executeOperation(
      store,
      args.scope,
      args.operation as FileOperation,
      Date.now(),
      projection,
    );

    /*
     * WHAT A PROJECTION PASS LEARNED, WRITTEN WHERE A PERSON CAN SEE IT.
     *
     * The gateway's copy of this posts to `/gateway/search-index/progress`,
     * because it is on the other side of a network boundary and holds a secret
     * rather than a session. There is no hop to make from inside the control
     * plane, so the internal mutations are called directly — and they are the
     * same two the route calls, so the policy about what may be applied to a
     * row is answered in one place whichever half reports.
     *
     * A failure goes to `recordProvisionResult` rather than to the progress
     * mutation, and that is not a tidy-up: the progress mutation carries two
     * counters and a `ready` flag, and a failed pass's counters are zero
     * because they are only computed when something moved. Reporting them
     * would write "no notes found" onto the row. `failed` is a state the
     * console already renders, with the owner's own "Try again" on it.
     */
    if (result.kind === "indexProjected") {
      if (result.failure !== undefined) {
        await ctx.runMutation(
          internal.functions.fastSearch.recordProvisionResult,
          {
            workspaceId: args.workspaceId,
            status: "failed",
            errorCode: result.failure,
            error: messageFor(result.failure),
          },
        );
        return result;
      }
      if (result.report) {
        await ctx.runMutation(
          internal.functions.fastSearch.recordProjectionProgress,
          {
            workspaceId: args.workspaceId,
            notesIndexed: result.notesIndexed,
            notesPending: result.notesPending,
            ready: result.ready,
          },
        );
      }
      // Same shape, same reasoning and the same place as the maintenance chain
      // below: scheduled from inside the barrier, which propagates no taint,
      // and only by a link that made progress and did not finish.
      const passes = Math.floor(args.operation.kind === "projectIndex"
        ? args.operation.passes ?? 0
        : 0);
      if (result.moved && !result.ready && passes > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "projectIndex", passes: passes - 1 },
        });
      }
      return result;
    }

    // A maintenance pass that got somewhere and is not finished schedules the
    // next one. Here rather than in a job of its own because a second internal
    // action that opens a bucket credential is a second credential barrier,
    // and `CREDENTIAL_BARRIERS` holding one entry with a long warning attached
    // is the point of it — see CLAUDE.md, "Credential barriers are enumerated,
    // never inferred". Scheduling from inside the barrier propagates no taint.
    if (
      args.operation.kind === "maintainIndex" &&
      result.kind === "indexMaintained" &&
      result.changed &&
      !result.complete
    ) {
      const passes = Math.floor(args.operation.passes ?? 0);
      if (passes > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "maintainIndex", passes: passes - 1 },
        });
      }
    }
    return result;
  },
});

/**
 * `fetch` with a per-request deadline.
 *
 * Guarded rather than assumed, exactly as in `functions/provisioning.ts`: this
 * runs in the Convex action runtime and in `@edge-runtime/vm` under test, and a
 * missing timeout is a slower failure rather than a wrong one.
 */
function timeoutFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  return globalThis.fetch(input, timeout ? { ...init, signal: timeout } : init);
}

/* -------------------------------------------------------------------------- */
/*                    the forward sync pass, one connection                   */
/* -------------------------------------------------------------------------- */

/**
 * What `googleSync.googleForwardSyncJob` answered.
 *
 * Written out rather than inferred because the inference would run through
 * `internal.functions.googleSync`, which is the cycle every annotated handler
 * in this file exists to avoid.
 */
type ForwardSyncJob =
  | null
  | { kind: "skip"; reason: string }
  | {
      kind: "run";
      connectionId: Id<"googleConnections">;
      product: "gmail";
      address: string;
      mailboxSlug: string;
      destinationFolder: string;
      folders: ("inbox" | "sent")[];
      quotaBytes: number;
      bytesAlreadyUsed: number;
      attachmentMode: "metadata-only" | "store";
      attachmentRetentionDays?: number | "forever";
      historyId?: string;
    }
  | {
      kind: "run";
      connectionId: Id<"googleConnections">;
      product: "calendar";
      address: string;
      destinationFolder: string;
      syncToken?: string;
      lastFullSyncDate?: string;
      contributorSourceIds: Id<"googleConnections">[];
    }
  | {
      kind: "run";
      connectionId: Id<"googleConnections">;
      product: "chat";
      address: string;
      destinationFolder: string;
      nonceSeed: string;
      workspaceNonceSeed: string;
      cursors: Record<string, string>;
      spaceSettings: Record<string, "included" | "excluded" | "paused">;
      contributorSourceIds: Id<"googleConnections">[];
    };

type ForwardSyncResult = Extract<OperationResult, { kind: "googleForwardSync" }>;

/**
 * Nothing to do, and the claim released.
 *
 * A skipped pass must leave `lastSyncAt` alone — a connection that has never
 * synced and one whose pass was skipped are the same connection, and making
 * the second look synced is precisely the confusion this whole loop exists to
 * remove.
 */
async function releaseForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  reason: string | undefined,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "skipped",
    errorCode: reason,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "skipped",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode: reason,
  };
}

/** A pass that could not run, recorded where the owner can read it. */
async function failForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  errorCode: string,
  error: string,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "failed",
    errorCode,
    error,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "failed",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode,
  };
}

const GMAIL_RATE_LIMIT_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

class CalendarTimezoneMismatchError extends Error {
  constructor() {
    super("Calendar accounts sharing a destination use different timezones");
    this.name = "CalendarTimezoneMismatchError";
  }
}

/**
 * Turn whatever went wrong into a code and a sentence a person can act on.
 *
 * Trimmed from the classifier #388 removed with the historical backfill: the
 * retry ladder went with it (a forward pass is retried by the sweep on its own
 * interval, with `SYNC_FAILURE_BACKOFF_MS` as the floor), but the
 * classification did not, because "Google refused this account" and "Google
 * was briefly unavailable" are still different sentences to show somebody.
 */
function classifyForwardSyncError(error: unknown): { code: string; message: string } {
  if (error instanceof CalendarTimezoneMismatchError) {
    return {
      code: "CALENDAR_TIMEZONE_MISMATCH",
      message: "Calendar accounts sharing this folder use different timezones. Choose separate folders for them.",
    };
  }
  if (error instanceof CalendarContributionConflictError) {
    return {
      code: "CALENDAR_SYNC_CONFLICT",
      message: "Calendar changed during this pass. The next scheduled pass will try again.",
    };
  }
  if (error instanceof CalendarPaginationError) {
    return {
      code: "CALENDAR_PAGINATION_STALLED",
      message: "Google Calendar returned a repeating page. The next scheduled pass will try again.",
    };
  }
  if (error instanceof CalendarApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: "GOOGLE_ACCESS_REFUSED",
        message: "Google refused access to Calendar. Reconnect the account and approve Calendar access.",
      };
    }
    if (error.status === 429) {
      return {
        code: "GOOGLE_RATE_LIMITED",
        message: "Google rate-limited Calendar. The next scheduled pass will try again.",
      };
    }
    return {
      code: "GOOGLE_UNAVAILABLE",
      message: "Google Calendar did not answer reliably. The next scheduled pass will try again.",
    };
  }
  if (error instanceof ChatContributionConflictError) {
    return {
      code: "CHAT_SYNC_CONFLICT",
      message: "Google Chat changed during this pass. The next scheduled pass will try again.",
    };
  }
  if (error instanceof ChatPaginationError) {
    return {
      code: "CHAT_PAGINATION_STALLED",
      message: "Google Chat returned a repeating page. The next scheduled pass will try again.",
    };
  }
  if (error instanceof ChatApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: "GOOGLE_ACCESS_REFUSED",
        message: "Google refused access to Chat. Reconnect the account and approve Chat access.",
      };
    }
    if (error.status === 429) {
      return {
        code: "GOOGLE_RATE_LIMITED",
        message: "Google rate-limited Chat. The next scheduled pass will try again.",
      };
    }
    return {
      code: "GOOGLE_UNAVAILABLE",
      message: "Google Chat did not answer reliably. The next scheduled pass will try again.",
    };
  }
  if (error instanceof GmailApiError) {
    const reason = typeof error.reason === "string" ? error.reason : undefined;
    const googleStatus = typeof error.googleStatus === "string" ? error.googleStatus : undefined;
    if (
      error.status === 429 ||
      (error.status === 403 &&
        (GMAIL_RATE_LIMIT_REASONS.has(reason ?? "") || googleStatus === "RESOURCE_EXHAUSTED"))
    ) {
      return {
        code: "GOOGLE_RATE_LIMITED",
        message: "Google rate-limited this mailbox. The next scheduled pass will try again.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        code: "GOOGLE_ACCESS_REFUSED",
        message: "Google refused access to this mailbox. Reconnect the account and approve Gmail access.",
      };
    }
    if (error.status >= 500) {
      return {
        code: "GOOGLE_UNAVAILABLE",
        message: "Google did not answer reliably. The next scheduled pass will try again.",
      };
    }
    return {
      code: `GMAIL_HTTP_${error.status}`,
      message: `Gmail answered with ${error.status}. The next scheduled pass will try again.`,
    };
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return {
      code: "GOOGLE_SYNC_TIMEOUT",
      message: "Gmail or storage took too long. The next scheduled pass resumes from the same cursor.",
    };
  }
  return {
    code: "GOOGLE_SYNC_FAILED",
    message: "This mailbox did not sync. The next scheduled pass resumes from the same cursor.",
  };
}

async function writeSharedCalendarDay(
  store: FileStore,
  path: string,
  text: string | null,
): Promise<{ wrote: boolean; bytes: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await store.get(path);
    const existingText = existing === null ? null : await existing.text();

    if (existingText !== null && !isCalendarDayNote(existingText)) {
      if (text === null) return { wrote: false, bytes: 0 };
      throw new Error("Calendar cannot replace a note the owner wrote in its destination folder");
    }
    if (text === null) {
      if (existing === null) return { wrote: false, bytes: 0 };
      const deleted = await store.delete(path, {
        onlyIf: { etagMatches: existing.etag },
      });
      if (deleted !== null) return { wrote: true, bytes: 0 };
      continue;
    }
    if (existingText === text) return { wrote: false, bytes: 0 };
    const written = await store.put(path, text, {
      onlyIf:
        existing === null
          ? { absent: true }
          : { etagMatches: existing.etag },
    });
    if (written !== null) {
      return { wrote: true, bytes: new TextEncoder().encode(text).byteLength };
    }
  }
  throw new CalendarContributionConflictError();
}

async function runGoogleCalendarForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "calendar" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities?.conditionalWrite !== true) {
    throw new Error("Shared Calendar sync requires storage with conditional writes");
  }
  const calendarStore = store as unknown as Parameters<typeof persistCalendarContribution>[0]["store"];
  const previous = await loadCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
  });
  const now = new Date().toISOString();
  const provider = await syncCalendarAccount({
    connection: {
      workspaceId: "private",
      account: job.address,
      calendarId: "primary",
      timezone: previous?.timezone,
      destinationFolder: job.destinationFolder,
      accessToken,
      syncToken: job.syncToken ?? null,
      lastFullSyncDate: job.lastFullSyncDate ?? null,
      eventCache: previous?.eventCache ?? new Map(),
    },
    store: calendarStore,
    fetchImpl: timeoutFetch,
    now,
    materialize: false,
  });
  if (provider.skipped || !provider.syncToken || !provider.lastFullSyncDate) {
    throw new Error("Google Calendar did not return a resumable cursor");
  }

  await persistCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
    contribution: {
      account: job.address,
      timezone: provider.timezone,
      destinationFolder: job.destinationFolder,
      eventCache: provider.eventCache,
    },
  });
  const contributions = await loadActiveCalendarContributions({
    store: calendarStore,
    sourceIds: job.contributorSourceIds,
  });
  const timezones = new Set(contributions.map((contribution) => contribution.timezone));
  if (timezones.size !== 1) throw new CalendarTimezoneMismatchError();
  const timezone = contributions[0]!.timezone;
  const merged = mergeEventCaches(
    contributions.map((contribution) => contribution.eventCache),
  );
  const nonceSeed = fnv1a64(
    [...job.contributorSourceIds].map(String).sort().join("\0"),
  );

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const date of provider.datesTouched) {
    const events = projectDay(merged, date);
    const path = calendarDayNotePath(
      { date },
      { folder: job.destinationFolder },
    );
    const text = events.length
      ? renderCalendarDay({
          date,
          timezone,
          events,
          nonce: `calendar:${nonceSeed}:${date}`,
          now,
          origin: "calendar-sync",
        })
      : null;
    const written = await writeSharedCalendarDay(store, path, text);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "calendar",
    status: "synced",
    calendarSyncToken: provider.syncToken,
    calendarLastFullSyncDate: provider.lastFullSyncDate,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: provider.syncToken !== job.syncToken,
    gapDetected: false,
    truncated: false,
  };
}

async function runGoogleChatForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "chat" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities === undefined) {
    throw new Error("Google Chat sync requires declared storage capabilities");
  }
  // `FileStore` is the deliberately narrow view used by file operations and
  // omits `StoredObject.arrayBuffer`; every adapter returned by
  // `storeForBinding` implements the full ContextStore contract that the
  // shared communications helpers accept. Keep the cast at this one adapter
  // boundary rather than widening every ordinary file operation.
  const chatStore = store as unknown as Parameters<typeof writeContactDraft>[0];
  const result = await syncGoogleChat({
    listSpaces: ({ pageToken }: { pageToken?: string }) =>
      listSpacesPage({ fetchImpl: timeoutFetch, accessToken, pageToken }),
    listMessages: ({
      spaceName,
      sinceCreateTime,
      pageToken,
    }: {
      spaceName: string;
      sinceCreateTime: string;
      pageToken?: string;
    }) =>
      listMessagesPage({
        fetchImpl: timeoutFetch,
        accessToken,
        spaceName,
        sinceCreateTime,
        pageToken,
      }),
    connection: {
      account: job.address,
      nonceSeed: job.nonceSeed,
      cursors: job.cursors,
      spaceSettings: job.spaceSettings,
      destinationFolder: job.destinationFolder,
    },
  });

  /*
   * Commit this account's provider result before reading the shared view.
   * The manifest-last contribution store means an interrupted pass is never
   * visible as a complete account slice, and loading every active source
   * fails closed if a sibling has not completed its first pass yet.
   */
  await persistChatContribution({
    store: chatStore,
    sourceId: job.connectionId,
    contribution: result.contribution,
  });
  const contributions = await loadActiveChatContributions({
    store: chatStore,
    sourceIds: job.contributorSourceIds,
  });
  const notes = renderSharedGoogleChat({
    contributions,
    nonceSeed: job.workspaceNonceSeed,
  });

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const part of notes) {
    const written = await writeDayPart(chatStore, part);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  for (const draft of result.contactDrafts) {
    const written = await writeContactDraft(chatStore, draft, {
      remainingQuotaBytes: Number.MAX_SAFE_INTEGER - bytesWritten,
    });
    if (written.quotaExceeded) {
      throw new Error("Google Chat Contact exceeded the bounded sync write budget");
    }
    if (written.wrote) bytesWritten += written.bytes;
  }

  /*
   * The cursor is the commit record. It moves last, after the shared daily
   * notes and organic Contacts have all settled, so a failed write makes the
   * next pass ask Google the same question again instead of losing content.
   */
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "chat",
    status: "synced",
    chatCursors: result.cursors,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: JSON.stringify(result.cursors) !== JSON.stringify(job.cursors),
    gapDetected: false,
    truncated: false,
  };
}

/**
 * ONE FORWARD PASS: advance this connection's cursor, write whatever changed.
 *
 * Forward-only, per #388 and `docs/decisions/communications.md`. Three shapes:
 *
 *  - **No cursor yet.** The connection was bound before a baseline could be
 *    read, so one is taken now from `users.getProfile` and stored. Nothing is
 *    fetched: forward-only means the mail from before this moment is not this
 *    loop's to collect.
 *  - **A cursor.** `history.list` from it, rebuild every day a changed message
 *    landed on from Gmail's live state, store the new cursor.
 *  - **An expired cursor.** Gmail's 404 comes back as `gapDetected` rather
 *    than an error. The documented recovery was a reconcile over the backfill
 *    window, which forward-only does not have — so the cursor is re-baselined
 *    and the gap is recorded on the row as a failure a person can read.
 *
 * **The cursor is never advanced past mail that was not written.** A quota
 * ceiling reached mid-pass, or anything thrown, leaves `historyId` exactly
 * where it was, so the next pass asks Gmail the same question again. Advancing
 * it would be the one bug in this file that loses somebody's mail silently.
 */
async function runGoogleForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run" }>,
): Promise<ForwardSyncResult> {
  try {
    /*
     * Inside the try, deliberately. Minting can *throw* as well as answer
     * `null` — a deployment with no Google client id configured, an envelope
     * that will not open — and a throw that escapes this function leaves the
     * scheduler holding the failure and the row holding its claim, so the
     * connection goes quiet for fifteen minutes with nothing on it to say why.
     */
    const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
      connectionId: job.connectionId,
    });
    if (minted === null) {
      // `mintGoogleAccessToken` has already marked the row
      // `reconnect_required` if Google refused the grant outright; this
      // records the pass itself.
      return await failForwardSync(
        ctx,
        job.connectionId,
        "GOOGLE_RECONNECT_REQUIRED",
        "Google needs to be reconnected before this mailbox can sync.",
      );
    }

    if (job.product === "chat") {
      return await runGoogleChatForwardSync(ctx, store, job, minted.accessToken);
    }
    if (job.product === "calendar") {
      return await runGoogleCalendarForwardSync(ctx, store, job, minted.accessToken);
    }

    if (job.historyId === undefined) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        // A cursor, not a sync: this pass read no mail, and the console must
        // be able to say so rather than showing a mailbox that looks current.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: false,
        truncated: false,
      };
    }

    const result = await runIncrementalSync({
      store,
      fetchImpl: timeoutFetch,
      accessToken: minted.accessToken,
      mailboxSlug: job.mailboxSlug,
      address: job.address,
      folders: job.folders,
      startHistoryId: job.historyId,
      folder: job.destinationFolder,
      // The same nonce the backfill used, so a day rewritten by either path
      // keeps its message anchors — see `packages/communications/src/note.js`.
      nonce: `gmail:${job.connectionId}`,
      /*
       * NO `now`, AND THAT IS THE WHOLE POINT OF A LOOP THAT REPEATS.
       *
       * `renderDay` defaults `updated` to the latest message's own `sentAt`
       * precisely so that re-rendering an unchanged day is byte-identical, and
       * `syncOneDay` forwards whatever `now` a caller passes straight through
       * to it. The backfill removed by #388 passed a wall clock, which was
       * survivable for a one-shot import and is not for a pass that runs every
       * few minutes: every touched day would get a new `updated`, a new write,
       * and a new etag, forever — churn wearing the costume of sync activity.
       * Attachment retention is measured against a real wall clock inside
       * `syncOneDay` regardless, so nothing here loses a clock it needed.
       */
      quotaBytes: job.quotaBytes,
      bytesAlreadyUsed: job.bytesAlreadyUsed,
      attachmentMode: job.attachmentMode,
      attachmentRetentionDays: job.attachmentRetentionDays,
    });

    if (result.gapDetected) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        gapDetected: true,
        // Re-baselining reads nothing either, for the same reason.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: true,
        truncated: false,
      };
    }

    if (result.quotaExceeded) {
      // Whatever was written stays written and is counted; the cursor does
      // not move, so the days this pass could not afford are asked for again
      // once the connection has room.
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "MAIL_QUOTA_EXCEEDED",
        error: "This connection reached its storage quota before the pass finished.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: result.truncated === true,
        errorCode: "MAIL_QUOTA_EXCEEDED",
      };
    }

    if (result.truncated === true && result.historyId === undefined) {
      /*
       * PAGED, BUT WITH NO SAFE PLACE TO RESUME.
       *
       * Gmail may return pages that contain no records for the requested
       * `messageAdded` history type while still returning a next page token.
       * If fifty such pages exhaust this pass's bound, there is no history
       * record id to persist. Marking the row as catching up would leave the
       * cursor unchanged and make the next sweep repeat the exact same fifty
       * pages forever. Fail visibly and honor the retry ladder instead.
       */
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
        error: "Google returned more mailbox history but no safe resume point. The next scheduled pass will try again.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: true,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
      };
    }

    /*
     * A WALK THAT RAN OUT OF PAGES IS NOT A FINISHED SYNC.
     *
     * `history.list` hands back the mailbox's *current* head on every page, so
     * a truncated walk that stored it would say "caught up" while holding only
     * the first pages — and everything behind them would be skipped forever,
     * with no gap signalled and the row reading `active`. `runIncrementalSync`
     * reports the truncation and offers the last record it actually walked
     * instead; the cursor moves there, and `catchUp` keeps this connection due
     * so the next pass drains further rather than waiting out its interval.
     */
    const truncated = result.truncated === true;
    await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: job.connectionId,
      status: "synced",
      historyId: result.historyId,
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      catchUp: truncated,
    });
    return {
      kind: "googleForwardSync",
      connectionId: job.connectionId,
      status: "synced",
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      cursorAdvanced: result.historyId !== undefined,
      gapDetected: false,
      truncated,
    };
  } catch (error) {
    // The first account in a multi-account workspace can finish before a
    // sibling has ever stored its contribution. That is an expected warm-up
    // state, not an outage: keep this account's cursor in place, release the
    // claim, and let the sibling's own due pass fill the missing slice.
    if (
      error instanceof ChatContributionIncompleteError ||
      error instanceof CalendarContributionIncompleteError
    ) {
      return await releaseForwardSync(
        ctx,
        job.connectionId,
        job.product === "calendar"
          ? "CALENDAR_WAITING_FOR_ACCOUNT"
          : "CHAT_WAITING_FOR_ACCOUNT",
      );
    }
    const { code, message } = classifyForwardSyncError(error);
    // Structured, and carrying no mail: an identifier, a code, and the name of
    // whatever was thrown.
    console.log(
      JSON.stringify({
        event: "google.forward_sync_failed",
        connectionId: job.connectionId,
        product: job.product,
        errorCode: code,
        errorName: error instanceof Error ? error.name : typeof error,
        gmailStatus: error instanceof GmailApiError ? error.status : undefined,
      }),
    );
    return await failForwardSync(ctx, job.connectionId, code, message);
  }
}

async function runGoogleGmailBackfill(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: Id<"googleSyncRuns">,
): Promise<Extract<OperationResult, { kind: "googleSyncRun" }>> {
  const job = await ctx.runQuery(internal.functions.googleConnect.googleGmailBackfillForRun, {
    workspaceId,
    runId,
  });
  if (job === null) {
    return {
      kind: "googleSyncRun",
      runId,
      status: "complete",
      totalUnits: 0,
      completedUnits: 0,
      itemsFound: 0,
      daysWithMail: 0,
      bytesWritten: 0,
      continue: false,
    };
  }

  await ctx.runMutation(internal.functions.googleConnect.stopGoogleGmailBackfillRun, {
    workspaceId,
    runId,
    errorCode: "GOOGLE_GMAIL_BACKFILL_DISABLED",
    message: "Historical Gmail imports are disabled. This account will sync new mail from its current cursor.",
  });
  return {
    kind: "googleSyncRun",
    runId,
    status: "failed",
    totalUnits: job.totalUnits,
    completedUnits: job.completedUnits,
    itemsFound: 0,
    daysWithMail: 0,
    bytesWritten: 0,
    continue: false,
  };
}

/**
 * Dispatch, and turn a `FileOpError` into a `ConvexError` the console can
 * branch on.
 *
 * Exported so `__tests__/fileOps.test.ts` can drive every operation against an
 * in-memory bucket without a credential, a workspace, or a session — which is
 * what keeps the barrier above small enough to audit.
 */
export async function executeOperation(
  store: FileStore,
  scope: Scope,
  operation: FileOperation,
  now: number = Date.now(),
  /**
   * This context's search database, for a `projectIndex` pass and for a
   * `search` to read.
   *
   * Passed in rather than built here for the same reason the store is: the
   * credential it is made from belongs to the barrier above, and this function
   * exists so that every operation is drivable from a test with no credential,
   * no workspace and no session. `null` for every other operation, and for a
   * projection whose row said there was nothing to do.
   */
  projection: ProjectionClient | null = null,
): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "pluginInventory": {
        const inventory = await inventoryPlugins(store) as PluginInventory;
        return { kind: "pluginInventory", ...inventory };
      }
      case "list": {
        const listing = await listFolder(store, { path: operation.path, scope });
        return { kind: "listing", ...listing };
      }
      case "read": {
        const file = await readFile(store, { path: operation.path, scope });
        return { kind: "file", ...file };
      }
      case "clearVault": {
        const cleared = await clearVaultBatch(store, operation.countOnly);
        return { kind: "vaultCleared", ...cleared };
      }
      case "ensurePrivacy": {
        try {
          const reset = await resetPrivacyManifest(store, { scope, now });
          return { kind: "privacyReset", ...reset };
        } catch (error) {
          if (error instanceof FileOpError && error.code === "PRIVACY_MANIFEST_USABLE") {
            return {
              kind: "privacyReset",
              path: PRIVACY_KEY,
              folders: [],
              backedUpTo: null,
              partial: false,
            };
          }
          throw error;
        }
      }
      case "search": {
        const results = await searchNotes(
          store,
          {
            query: operation.query,
            prefix: operation.prefix,
            scope,
            limit: operation.limit,
            refreshOnMiss: operation.refreshOnMiss,
          },
          projection,
        );
        return { kind: "searchResults", ...results };
      }
      case "notePaths": {
        const found = await notePathIndex(store, scope);
        return { kind: "notePaths", paths: found?.paths ?? null };
      }
      case "projectIndex": {
        // Scope-blind, exactly like `maintainIndex` below: the tier a note is
        // copied at comes from `privacy.md` per note, never from whoever
        // scheduled the pass. A projection built per caller would be one
        // database per membership.
        if (projection === null) return IDLE_PROJECTION;
        const pass = await projectSearchIndex(store, projection);
        return {
          kind: "indexProjected",
          projected: pass.projected,
          deleted: pass.deleted,
          notesIndexed: pass.notesIndexed,
          notesPending: pass.notesPending,
          ready: pass.ready,
          moved: pass.moved,
          report: pass.report,
          failure: pass.failure ?? undefined,
        };
      }
      case "maintainIndex": {
        // Scope-blind on purpose: an index describes the bucket, and building
        // it per caller would mean one index per membership. What is scoped is
        // every path, snippet and count that leaves a *search* — `isVisible`
        // in `searchNotes`, never here.
        const pass = await maintainSearchIndex(store);
        return { kind: "indexMaintained", ...pass };
      }
      case "write": {
        const written = await writeFile(store, {
          path: operation.path,
          text: operation.text,
          expectedEtag: operation.expectedEtag,
          scope,
          now,
        });
        /*
          A note carrying a form block gets that form's response file created
          here, on the **author's** write, because the author holds write access
          and the submitter may not — see `ensureFormResponseFiles`.

          After the note's own write and never before it, and its failures are
          swallowed rather than raised: the note is the customer's content and
          is already in the bucket. A response file that could not be seeded is
          a form that is not collecting yet, and re-raising here would report a
          save that succeeded as a save that failed.
        */
        const forms = await ensureFormResponseFiles(store, {
          text: operation.text,
          notePath: written.path,
        }).catch(() => ({ created: [], occupied: [] }));
        return { kind: "written", ...written, forms };
      }
      case "form": {
        const applied = await runFormAction(store, {
          scope,
          path: operation.path,
          formId: operation.formId,
          actor: { name: operation.actorName, role: operation.actorRole },
          action: operation.action,
        });
        return { kind: "formApplied", ...applied };
      }
      case "removeEncryption": {
        const written = await removeNoteEncryptionOp(store, {
          path: operation.path,
          text: operation.text,
          expectedEtag: operation.expectedEtag,
          scope,
        });
        /*
          No form seeding on this path, and that is not an omission. Removing a
          note's encryption replaces ciphertext with the plaintext its owner
          just decrypted on their device; the response file for any form inside
          it was seeded when the form was written, and re-running the seed here
          would create one for a form that has been collecting for months.
        */
        return { kind: "written", ...written, forms: { created: [], occupied: [] } };
      }
      case "createFolder": {
        const created = await createFolder(store, { path: operation.path, scope, now });
        return { kind: "folderCreated", ...created };
      }
      case "move": {
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          scope,
          now,
        });
        return { kind: "moved", ...moved };
      }
      case "copy": {
        const copied = await copyPath(store, {
          from: operation.from,
          to: operation.to,
          scope,
        });
        return { kind: "moved", ...copied };
      }
      case "duplicate": {
        const copied = await duplicatePath(store, { path: operation.path, scope });
        return { kind: "moved", ...copied };
      }
      case "archive": {
        const moved = await archivePath(store, { path: operation.path, scope, now });
        return { kind: "moved", ...moved };
      }
      case "delete": {
        const deleted = await deletePath(store, {
          path: operation.path,
          confirmation: operation.confirmation,
          scope,
        });
        return { kind: "deleted", ...deleted };
      }
      case "setNoteGroup": {
        // The same writer as `setVisibility`, with a group in place of a tier:
        // `fileOps.setVisibility` has taken a `Visibility` since #418 and a
        // group is one. A separate operation rather than a widened
        // `setVisibility` because the ARGUMENT validator must stay two-valued —
        // widening it would make every path that takes a visibility a way to
        // mint a rule, which is exactly what the gateway refuses AI clients.
        const result = await setVisibility(store, {
          path: operation.path,
          visibility: `@${operation.group}` as Visibility,
          scope,
        });
        return { kind: "visibility" as const, ...result };
      }
      case "setVisibility": {
        const result = await setVisibility(store, {
          path: operation.path,
          visibility: operation.visibility,
          scope,
        });
        return { kind: "visibility", ...result };
      }
      case "setFolderVisibility": {
        const result = await setFolderVisibility(store, {
          path: operation.path,
          visibility: operation.visibility,
          scope,
        });
        return { kind: "visibility", ...result };
      }
      case "writeImage": {
        const written = await writeImage(store, {
          leaf: operation.leaf,
          bytes: new Uint8Array(operation.bytes),
          contentType: operation.contentType,
        });
        return { kind: "imageWritten", ...written };
      }
      case "importVault": {
        const imported = await importVaultFiles(store, {
          scope,
          files: operation.files.map((file) => ({
            ...file,
            bytes: new Uint8Array(file.bytes),
          })),
        });
        return { kind: "vaultImported", ...imported };
      }
      case "readImage": {
        const bytes = await readImage(store, operation.leaf);
        return { kind: "image", bytes };
      }
      case "resetPrivacy": {
        const result = await resetPrivacyManifest(store, { scope, now });
        return { kind: "privacyReset", ...result };
      }
    }
  } catch (error) {
    throw toConvexError(error);
  }
}

/**
 * A `FileOpError` carries a code and a message written for a person. Anything
 * else is a provider or runtime failure whose text we have not vetted, so it
 * becomes one fixed sentence rather than being forwarded — a bucket's error
 * body is not ours to publish, and could echo a request we made.
 */
function toConvexError(error: unknown): ConvexError<{
  code: string;
  message: string;
  currentEtag?: string;
}> {
  if (error instanceof FileOpError) {
    return new ConvexError({
      code: error.code,
      message: error.message,
      ...(error.currentEtag === undefined ? {} : { currentEtag: error.currentEtag }),
    });
  }
  if (error instanceof ConvexError) return error;
  return new ConvexError({
    code: "STORAGE_FAILED",
    message: "Your bucket did not complete that request. Try again.",
  });
}

/* -------------------------------------------------------------------------- */
/*                              the public surface                            */
/* -------------------------------------------------------------------------- */

/**
 * How long one context in a blended search may take before the page goes on
 * without it.
 *
 * Under the console's own ten-second client timeout, so a blended page ends as
 * a partial answer somebody can act on rather than as the spinner that cannot
 * stop — `useContextSearch` documents that failure at length and this is the
 * server-side half of not causing it. Comfortably above what a projection read
 * costs (one D1 round trip) and above the R2 fall-through a miss pays for,
 * which is what it is really bounding.
 */
const SOURCE_DEADLINE_MS = 7_000;

/** What `searchContexts` answers. Mirrors `blendedResultsValidator` exactly. */
type BlendedAnswer = {
  results: {
    workspaceId: Id<"workspaces">;
    slug: string;
    displayName: string;
    path: string;
    title: string;
    snippet: string;
  }[];
  matchCount: number;
  matchCountIsFloor: boolean;
  cursor: string | null;
  sources: {
    workspaceId: Id<"workspaces">;
    slug: string;
    displayName: string;
    state: "ok" | "indexing" | "failed";
    matchCount: number;
    matchCountIsFloor: boolean;
  }[];
  searchableCount: number;
};

/**
 * One source's answer, or `null` because it did not arrive in time or at all.
 *
 * Both halves matter. The timer is cleared in a `finally` so a page that ends
 * early does not leave one pending per context; and the work is wrapped in its
 * own `catch` **before** the race rather than after it, because a promise that
 * rejects after the timeout has already won is an unhandled rejection — which
 * in a Convex action is a log line about somebody's bucket, attached to no
 * request, in a deployment where the request it belonged to succeeded.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        (value) => value,
        () => null,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The signed-in user, or a `ConvexError` a client can act on.
 *
 * A plain `Error` would be scrubbed to "Server Error" and dead-end the person
 * in the root error boundary with nothing to do about it — see the note at the
 * top of `lib/workspaceAuth.ts`.
 */
async function callerId(ctx: ActionCtx | QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

const durableMoveValidator = v.object({
  jobId: v.id("gatewayJobs"),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("complete"),
    v.literal("failed"),
  ),
  phase: v.optional(v.union(v.literal("copying"), v.literal("deleting"))),
  completed: v.optional(v.number()),
  total: v.optional(v.number()),
  updatedAt: v.number(),
});

/**
 * Recent durable folder moves, owner-only and deliberately path-free.
 *
 * A move can name a private folder. Settings needs its state and measured
 * counts, never the source, destination, marker id, provider error, grant, or
 * acting client. Completed rows stay visible briefly so 99% does not turn
 * directly into an empty card before the owner sees the outcome.
 */
export const listDurableMoves = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(durableMoveValidator),
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const rows = await ctx.db
      .query("gatewayJobs")
      .withIndex("by_workspace_updatedAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const completedCutoff = Date.now() - 24 * 60 * 60 * 1_000;
    return rows
      .filter((row) => row.status !== "complete" || row.updatedAt >= completedCutoff)
      .slice(0, 10)
      .map((row) => ({
        jobId: row._id,
        status: row.status,
        ...(row.progressPhase === undefined ? {} : { phase: row.progressPhase }),
        ...(row.progressCompleted === undefined ? {} : { completed: row.progressCompleted }),
        ...(row.progressTotal === undefined ? {} : { total: row.progressTotal }),
        updatedAt: row.updatedAt,
      }));
  },
});

/** One folder's contents. Any member may read. */
export const listFiles = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: listingValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "listing" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "list", path: args.path },
    });
    return result as Extract<OperationResult, { kind: "listing" }>;
  },
});

/**
 * Structured Obsidian plugin compatibility for the first-party console.
 *
 * Owner-only because `.obsidian/` is outside the privacy manifest: a member
 * may read the notes their scope permits, but that says nothing about whether
 * they may inventory another person's installed software or its settings.
 * The credential barrier returns only manifest metadata and scan findings;
 * bundle text and `data.json` never leave it.
 */
export const listObsidianPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginInventoryValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Extract<OperationResult, { kind: "pluginInventory" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "pluginInventory" },
    });
    return result as Extract<OperationResult, { kind: "pluginInventory" }>;
  },
});

/** One note's markdown. Any member may read what their scope can see. */
export const readNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: fileValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "file" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "read", path: args.path },
    });
    return result as Extract<OperationResult, { kind: "file" }>;
  },
});

/**
 * Search this context's notes. Any member may search what their scope can see.
 *
 * The console's palette used to filter the folders somebody had happened to
 * expand, and said so — "only folders you have opened are searched". That is
 * a file picker, not search: the answer to "where did I write about Ikenna"
 * lived in a folder the person had not opened, which is exactly the case
 * search exists for. This asks the bucket, through the same index and the
 * same code an AI client's `search_notes` answers from.
 */
export const searchContext = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    prefix: v.optional(v.string()),
  },
  returns: searchResultsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "searchResults" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "search", query: args.query, prefix: args.prefix },
    })) as Extract<OperationResult, { kind: "searchResults" }>;

    // The index this answer read is the index some earlier pass built, and a
    // search does no maintenance of its own — that is what took a console
    // search over a real brain from twenty-odd seconds to a fraction of one.
    // So the answer's own report of how far behind the index is decides
    // whether a pass runs behind it.
    //
    // **Scheduled, never called.** `ctx.runAction` would put a full listing of
    // the customer's bucket back in front of the person waiting, which is the
    // whole defect; `ctx.scheduler.runAfter` enqueues a job in a separate
    // transaction whose return value is discarded, so this action returns as
    // soon as it has an answer (CLAUDE.md, "Scheduling is not calling"). The
    // target is a statically resolvable `internal.` reference, as that rule
    // requires.
    //
    // Nothing is scheduled for a converged index. A pass per search over a
    // bucket with no work in it is a full listing per search, billed to the
    // customer, to discover there was nothing to do.
    if (result.indexMissing || result.indexIncomplete) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope,
        operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
      });
    }
    return result;
  },
});

/**
 * Every note path this member's scope may see, for the editor's link
 * resolution — `[[name]]` following and the `[[` completion.
 *
 * **Read-only, and deliberately schedules nothing.** `searchContext` chains
 * `maintainIndex` behind a miss because somebody is watching a spinner for an
 * answer about a word they typed; nobody is watching this one, and a context
 * that has never been searched simply resolves fewer links until an ordinary
 * search — or `maintainIndex`'s own hourly reach — catches the index up. See
 * `docs/decisions/app-and-console.md`, "L1".
 */
export const notePaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: notePathsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "notePaths" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "notePaths" },
    });
    return result as Extract<OperationResult, { kind: "notePaths" }>;
  },
});

/**
 * One search across several contexts, blended into one list.
 *
 * ## Why the fan-out is here
 *
 * Because the per-context search already is. This action resolves a scope,
 * calls `runFileOperation`'s `search` once per context, and blends the answers
 * — and every part it does not do is the point: it does not open a bucket, does
 * not know what a projection is, does not rank, does not cut a snippet, and
 * **does not contain a privacy filter.** `searchNotes` owns all of that, once,
 * for the console and for `search_notes` alike, exactly as
 * `docs/decisions/search.md` requires. A blended search that re-derived who may
 * see a hit would be a third copy of `canSee` and the one most likely to be
 * wrong, because it is the one nobody would think to test per tier.
 *
 * The gateway was the alternative home and it is the wrong one twice: a Worker
 * has a fifty-subrequest ceiling per invocation, which a fan-out over eight
 * customers' buckets walks into by itself, and the console would need a request
 * per context per page — which is the "the client makes one request per page"
 * property this exists to give it.
 *
 * ## Every page re-checks everything
 *
 * Membership, role and fast-search state are re-read on every page of every
 * query: `searchableContextsFor` is a live read, `authorizeFileAccess` runs per
 * context per page, and the scope the caller asked for can only narrow that.
 * So somebody removed from a workspace between page one and page two gets page
 * two without it — no cached scope, no cursor-carried permission. The cursor
 * carries offsets and nothing else, and `decodeCursor` says at length why.
 *
 * ## What it deliberately does not do
 *
 * **It schedules index maintenance for one case only: a context with no index
 * at all.** `searchContext` schedules a pass behind any lagging index, because
 * a person searching one context is the cheapest possible trigger for catching
 * that context up. Multiplying that by the width of a scope would put a full
 * bucket listing per context behind every keystroke on this page, billed to
 * every one of those customers, so a merely *incomplete* index is left to the
 * passes that already ride the gateway's own searches.
 *
 * A **missing** one is different in kind and is the state this page created for
 * itself the moment it started searching contexts without a projection: a
 * context nobody has ever searched directly has no shard index, answers every
 * query with `indexMissing`, and would report "still being indexed" on this
 * page forever — a permanent apology that no amount of waiting resolves. So the
 * first page of a search schedules one chain per such context and no more:
 * later pages of the same query schedule nothing, and the condition is
 * self-limiting, because a context that has been indexed once is never
 * `indexMissing` again.
 *
 * **It logs no query text.** Nothing in this function writes the words
 * somebody typed anywhere: not to audit, not to a structured log, not into the
 * cursor. `docs/decisions/search.md` records that as a decision rather than an
 * omission — a search over several people's contexts is a much better guess at
 * what somebody is working on than any single note read.
 */
export const searchContexts = action({
  args: {
    query: v.string(),
    /**
     * The scope, as workspace ids. Absent or empty means every context this
     * caller can search. An id this caller may not search is **dropped**, identically to
     * one that never existed — see `resolveScope`.
     */
    contexts: v.optional(v.array(v.id("workspaces"))),
    /** A cursor from a previous page of this same query, or nothing. */
    cursor: v.optional(v.string()),
  },
  returns: blendedResultsValidator,
  handler: async (ctx, args): Promise<BlendedAnswer> => {
    const actorUserId = await callerId(ctx);
    const searchable = await ctx.runQuery(
      internal.functions.fastSearch.searchableContextsFor,
      { actorUserId },
    );

    const query = args.query.trim();
    const scope = resolveScope(searchable, args.contexts);
    if (query === "" || scope.length === 0) {
      // An empty query and an empty scope are both "nothing was asked", and
      // both answer with an empty page rather than an error. `searchableCount`
      // is what lets the page tell the two apart on screen.
      return {
        results: [],
        matchCount: 0,
        matchCountIsFloor: false,
        cursor: null,
        sources: [],
        searchableCount: searchable.length,
      };
    }

    const fingerprint = queryFingerprint(query);
    const read = decodeCursor(args.cursor, fingerprint);
    const offsets = read.kind === "page" ? read.offsets : {};

    /*
      ONE DEADLINE PER SOURCE, AND A SLOW CONTEXT COSTS ONLY ITSELF.

      `Promise.all` over a list where each entry has already been wrapped, so
      the whole page is bounded by the slowest source that answers *in time*
      rather than by the slowest source. A bucket that has stopped answering
      would otherwise hold every other context's results behind it, which is
      the failure mode a blended list makes worse rather than better: one
      unreachable context and the page has nothing on it.
    */
    const answered = await Promise.all(
      scope.map(async (context) => {
        const offset = offsets[context.workspaceId] ?? 0;
        const asked = depthFor(offset);
        const settled = await withDeadline(
          (async () => {
            // The one authorization function, per context, per page. The
            // searchable list already established membership; this re-establishes
            // it through the same query every other file action uses, so a
            // blended search cannot come to disagree with a single one about
            // what role means what scope.
            const { scope: tier } = await ctx.runQuery(
              internal.functions.files.authorizeFileAccess,
              {
                actorUserId,
                workspaceId: context.workspaceId as Id<"workspaces">,
                minimum: "member" as const,
              },
            );
            const answer = (await ctx.runAction(
              internal.functions.files.runFileOperation,
              {
                workspaceId: context.workspaceId as Id<"workspaces">,
                scope: tier,
                operation: {
                  kind: "search" as const,
                  query,
                  limit: asked,
                  // See `searchNotes`: a fan-out misses in most of its contexts
                  // by construction, and one listing per miss is the cost of a
                  // rule written for a single spinner.
                  refreshOnMiss: false,
                },
              },
            )) as Extract<OperationResult, { kind: "searchResults" }>;
            // The tier rides back out with the answer so the maintenance pass
            // below can be scheduled with the scope this search was authorized
            // at, rather than re-deriving one outside the race — where a second
            // `authorizeFileAccess` would be a second answer to the same
            // question.
            return { answer, tier };
          })(),
          SOURCE_DEADLINE_MS,
        );
        return {
          context,
          offset,
          asked,
          settled: settled === null ? null : settled.answer,
          tier: settled === null ? null : settled.tier,
        };
      }),
    );

    const sources: BlendSource[] = [];
    const rows: BlendedAnswer["sources"] = [];
    let matchCount = 0;
    let matchCountIsFloor = false;
    for (const { context, offset, asked, settled } of answered) {
      if (settled === null) {
        // A refusal, a timeout and a thrown storage error are one state on
        // screen, and deliberately: what a person can do about each is press
        // retry on that row. The reason is not carried because it would be a
        // provider's sentence about somebody else's bucket.
        //
        // **And the blended total stops claiming to be exact.** A source that
        // was never read is a walk cut short, which is the condition under
        // which every other count in this system reports itself as a floor —
        // `search/CONTRACT.md`'s rule, and the census's own language. Summing
        // the sources that answered and calling the result a total would be a
        // confident number over a scope only half searched, and the one place
        // that understatement matters most is the page whose whole promise is
        // "everything you can reach".
        matchCountIsFloor = true;
        rows.push({
          workspaceId: context.workspaceId as Id<"workspaces">,
          slug: context.slug,
          displayName: context.displayName,
          state: "failed",
          matchCount: 0,
          matchCountIsFloor: false,
        });
        continue;
      }
      sources.push({
        key: context.workspaceId,
        hits: settled.hits,
        offset,
        asked,
      });
      matchCount += settled.matchCount;
      matchCountIsFloor = matchCountIsFloor || settled.matchCountIsFloor;
      rows.push({
        workspaceId: context.workspaceId as Id<"workspaces">,
        slug: context.slug,
        displayName: context.displayName,
        // An index that has not caught up is not "no matches here", and a
        // blended list is where that lie is easiest to tell: nine contexts
        // answer, the tenth is still indexing, and its silence reads as an
        // answer about somebody's notes.
        state: settled.indexMissing || settled.indexIncomplete ? "indexing" : "ok",
        matchCount: settled.matchCount,
        matchCountIsFloor: settled.matchCountIsFloor,
      });
    }

    /*
      The one pass this page schedules — see "what it deliberately does not do".

      A context with no shard index at all answers every query with
      `indexMissing` and would say "still being indexed" on this page for as
      long as nobody searched it from somewhere else. One chain per such
      context, on the first page of a query only, and never for an index that
      merely lags: that one catches up behind the searches the gateway and the
      palette already ride.

      **Scheduled, never called** (CLAUDE.md, "Scheduling is not calling"). A
      `runAction` here would put a full listing of somebody's bucket in front of
      the person waiting for this page, which is the defect the whole
      no-maintenance rule exists to avoid.
    */
    if (args.cursor === undefined) {
      for (const { context, settled, tier } of answered) {
        if (settled === null || tier === null || !settled.indexMissing) continue;
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: context.workspaceId as Id<"workspaces">,
          scope: tier,
          operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
        });
      }
    }

    const page = pageOf(fuse(sources), sources);
    const named = new Map(scope.map((context) => [context.workspaceId, context]));
    return {
      results: page.rows.map((row) => {
        const context = named.get(row.key)!;
        return {
          workspaceId: context.workspaceId as Id<"workspaces">,
          slug: context.slug,
          displayName: context.displayName,
          path: row.path,
          title: row.title,
          snippet: row.snippet,
        };
      }),
      matchCount,
      matchCountIsFloor,
      cursor: page.next === null ? null : encodeCursor(fingerprint, page.next),
      sources: rows,
      searchableCount: searchable.length,
    };
  },
});

/**
 * Save a note. Requires `editor`.
 *
 * `expectedEtag` is what the editor read. Omit it only to create a new file —
 * omitting it for an existing path is a conflict, not an overwrite. There is
 * no "force" flag; the console reloads and lets the person merge.
 */
export const writeNote = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "written" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "write",
        path: args.path,
        text: args.text,
        expectedEtag: args.expectedEtag,
      },
    })) as Extract<OperationResult, { kind: "written" }>;

    // Paths and an outcome. Never the text — the schema's flat-scalar `details`
    // makes an accidental `{ body }` impossible, and this is the deliberate
    // half of that rule.
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: args.expectedEtag === undefined ? "file.create" : "file.write",
      paths: [result.path],
      details: { conflictCheck: result.conflictCheck },
    });
    return result;
  },
});

const MAX_VAULT_IMPORT_BATCH_FILES = 20;
const MAX_VAULT_IMPORT_BATCH_BYTES = 4_500_000;
const MAX_VAULT_IMPORT_FILES = 100_000;
const MAX_VAULT_IMPORT_BATCHES = 5_000;
const VAULT_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

type VaultImportJobStatus = {
  jobId: Id<"vaultImportJobs">;
  strategy: "merge" | "folder" | "replace";
  status: "active" | "paused" | "complete";
  totalFiles: number;
  completedFiles: number;
  createdFiles: number;
  skippedFiles: number;
  completedBatches: number[];
  replacement?: {
    phase: "counting" | "deleting" | "uploading";
    totalObjects: number;
    deletedObjects: number;
  };
};

function vaultImportJobStatus(job: Doc<"vaultImportJobs">): VaultImportJobStatus {
  return {
    jobId: job._id,
    strategy: job.strategy,
    status: job.status,
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles,
    createdFiles: job.createdFiles,
    skippedFiles: job.skippedFiles,
    completedBatches: [...job.completedBatches].sort((left, right) => left - right),
    ...(job.replacement === undefined ? {} : { replacement: job.replacement }),
  };
}

function validateVaultImportPlan(args: {
  sourceFingerprint: string;
  totalFiles: number;
  totalBytes: number;
  totalBatches: number;
}): void {
  if (!VAULT_FINGERPRINT_PATTERN.test(args.sourceFingerprint)) {
    throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "Choose the vault again to start this import." });
  }
  if (
    !Number.isSafeInteger(args.totalFiles) ||
    args.totalFiles < 1 ||
    args.totalFiles > MAX_VAULT_IMPORT_FILES ||
    !Number.isSafeInteger(args.totalBytes) ||
    args.totalBytes < 0 ||
    !Number.isSafeInteger(args.totalBatches) ||
    args.totalBatches < 1 ||
    args.totalBatches > MAX_VAULT_IMPORT_BATCHES ||
    args.totalBatches > args.totalFiles
  ) {
    throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "That vault is too large to import safely." });
  }
}

/**
 * Start or resume the metadata half of a local vault import.
 *
 * File bytes remain on the person's device. The row remembers only counts and
 * completed batch numbers, so a closed tab can reselect the same vault and
 * avoid sending batches that already finished.
 */
export const startVaultImport = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
    confirmation: v.optional(v.string()),
    sourceFingerprint: v.string(),
    totalFiles: v.number(),
    totalBytes: v.number(),
    totalBatches: v.number(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    validateVaultImportPlan(args);
    if (args.strategy === "replace" && args.confirmation !== "I understand") {
      throw new ConvexError({
        code: "IMPORT_REPLACE_CONFIRMATION_REQUIRED",
        message: "Type I understand exactly before replacing this bucket.",
      });
    }
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const recent = await ctx.db
      .query("vaultImportJobs")
      .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const matching = recent.find(
      (job) =>
        job.actorUserId === actorUserId &&
        job.status !== "complete" &&
        job.strategy === args.strategy &&
        job.sourceFingerprint === args.sourceFingerprint &&
        job.totalFiles === args.totalFiles &&
        job.totalBytes === args.totalBytes &&
        job.totalBatches === args.totalBatches,
    );
    const now = Date.now();
    if (matching !== undefined) {
      if (matching.status !== "active") {
        await ctx.db.patch(matching._id, { status: "active", updatedAt: now });
      }
      return vaultImportJobStatus({ ...matching, status: "active", updatedAt: now });
    }
    for (const job of recent) {
      if (job.actorUserId === actorUserId && job.status === "active") {
        await ctx.db.patch(job._id, { status: "paused", updatedAt: now });
      }
    }
    const jobId = await ctx.db.insert("vaultImportJobs", {
      workspaceId: args.workspaceId,
      actorUserId,
      strategy: args.strategy,
      sourceFingerprint: args.sourceFingerprint,
      totalFiles: args.totalFiles,
      totalBytes: args.totalBytes,
      totalBatches: args.totalBatches,
      completedBatches: [],
      completedFiles: 0,
      createdFiles: 0,
      skippedFiles: 0,
      ...(args.strategy === "replace" ? {
        replacement: {
          phase: "counting" as const,
          totalObjects: 0,
          deletedObjects: 0,
        },
      } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(jobId);
    if (created === null) throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "The import could not start." });
    return vaultImportJobStatus(created);
  },
});

export const recordVaultClearBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    mode: v.union(v.literal("counted"), v.literal("deleted")),
    objects: v.number(),
    complete: v.boolean(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== args.actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint ||
      job.strategy !== "replace" ||
      job.replacement === undefined ||
      !Number.isSafeInteger(args.objects) ||
      args.objects < 0
    ) return null;

    const now = Date.now();
    if (job.replacement.phase === "counting" && args.mode === "counted") {
      const replacement = {
        phase: args.objects === 0 ? "uploading" as const : "deleting" as const,
        totalObjects: args.objects,
        deletedObjects: 0,
      };
      await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
      return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
    }
    if (job.replacement.phase === "deleting" && args.mode === "deleted") {
      const rawDeleted = job.replacement.deletedObjects + args.objects;
      const totalObjects = Math.max(job.replacement.totalObjects, rawDeleted);
      const replacement = {
        phase: args.complete ? "uploading" as const : "deleting" as const,
        totalObjects,
        deletedObjects: args.complete ? totalObjects : rawDeleted,
      };
      await ctx.db.patch(job._id, { replacement, status: "active", updatedAt: now });
      return vaultImportJobStatus({ ...job, replacement, status: "active", updatedAt: now });
    }
    return vaultImportJobStatus(job);
  },
});

/** Count, then remove, one retryable page of every object in a replacement bucket. */
export const clearVaultImportBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, {
      jobId: args.jobId,
    }) as Doc<"vaultImportJobs"> | null;
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint ||
      job.strategy !== "replace" ||
      job.replacement === undefined
    ) {
      throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That replacement is no longer available." });
    }
    if (job.replacement.phase === "uploading") return vaultImportJobStatus(job);

    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "clearVault", countOnly: job.replacement.phase === "counting" },
    }) as Extract<OperationResult, { kind: "vaultCleared" }>;
    const recorded = await ctx.runMutation(internal.functions.files.recordVaultClearBatch, {
      jobId: args.jobId,
      actorUserId,
      workspaceId: args.workspaceId,
      sourceFingerprint: args.sourceFingerprint,
      mode: result.mode,
      objects: result.objects,
      complete: result.complete,
    });
    if (recorded === null) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (result.mode === "deleted" && result.objects > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.replace.clear",
        paths: [],
        details: { objectsDeleted: result.objects },
      });
    }
    return recorded;
  },
});

/** The latest unfinished import for this owner and workspace, without paths or content. */
export const latestVaultImportJob = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const recent = await ctx.db
      .query("vaultImportJobs")
      .withIndex("by_workspace_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const job = recent.find((candidate) => candidate.actorUserId === actorUserId && candidate.status !== "complete");
    return job === undefined ? null : vaultImportJobStatus(job);
  },
});

/** Record the local uploader stopping while keeping every completed batch resumable. */
export const pauseVaultImport = mutation({
  args: { workspaceId: v.id("workspaces"), jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) return null;
    if (job.status === "active") await ctx.db.patch(job._id, { status: "paused", updatedAt: Date.now() });
    return vaultImportJobStatus(job.status === "active" ? { ...job, status: "paused" } : job);
  },
});

export const vaultImportJobForBatch = internalQuery({
  args: { jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, args): Promise<Doc<"vaultImportJobs"> | null> => await ctx.db.get(args.jobId),
});

export const recordVaultImportBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    filesProcessed: v.number(),
    filesCreated: v.number(),
    filesSkipped: v.number(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.workspaceId !== args.workspaceId ||
      job.actorUserId !== args.actorUserId ||
      job.sourceFingerprint !== args.sourceFingerprint
    ) return null;
    if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
    const completedBatches = [...job.completedBatches, args.batchIndex].sort((left, right) => left - right);
    const completedFiles = job.completedFiles + args.filesProcessed;
    if (
      !Number.isSafeInteger(args.batchIndex) ||
      args.batchIndex < 0 ||
      args.batchIndex >= job.totalBatches ||
      !Number.isSafeInteger(args.filesProcessed) ||
      args.filesProcessed < 1 ||
      args.filesCreated < 0 ||
      args.filesSkipped < 0 ||
      args.filesCreated + args.filesSkipped !== args.filesProcessed ||
      completedFiles > job.totalFiles
    ) return null;
    const complete = completedBatches.length === job.totalBatches && completedFiles === job.totalFiles;
    const now = Date.now();
    const patch = {
      completedBatches,
      completedFiles,
      createdFiles: job.createdFiles + args.filesCreated,
      skippedFiles: job.skippedFiles + args.filesSkipped,
      status: complete ? "complete" as const : "active" as const,
      updatedAt: now,
      ...(complete ? { completedAt: now } : {}),
    };
    await ctx.db.patch(job._id, patch);
    return vaultImportJobStatus({ ...job, ...patch });
  },
});

/**
 * Upload one numbered batch and atomically mark its progress after the bucket
 * accepts it. Repeating the same number returns the stored result and never
 * sends those bytes to storage twice.
 */
export const importVaultJobBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => {
    if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
      });
    }
    const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
      throw new ConvexError({ code: "IMPORT_BATCH_INVALID", message: "That upload batch is too large." });
    }
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const job = await ctx.runQuery(internal.functions.files.vaultImportJobForBatch, { jobId: args.jobId }) as Doc<"vaultImportJobs"> | null;
    if (job === null || job.workspaceId !== args.workspaceId || job.actorUserId !== actorUserId) {
      throw new ConvexError({ code: "IMPORT_JOB_NOT_FOUND", message: "That import is no longer available." });
    }
    if (
      job.sourceFingerprint !== args.sourceFingerprint ||
      !Number.isSafeInteger(args.batchIndex) ||
      args.batchIndex < 0 ||
      args.batchIndex >= job.totalBatches
    ) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (job.strategy === "replace" && job.replacement?.phase !== "uploading") {
      throw new ConvexError({
        code: "IMPORT_REPLACE_NOT_READY",
        message: "The existing bucket must finish clearing before files upload.",
      });
    }
    if (job.completedBatches.includes(args.batchIndex)) return vaultImportJobStatus(job);
    const completedFilesAfterBatch = job.completedFiles + args.files.length;
    const completedBatchCountAfterBatch = job.completedBatches.length + 1;
    if (
      completedFilesAfterBatch > job.totalFiles ||
      (completedBatchCountAfterBatch === job.totalBatches && completedFilesAfterBatch !== job.totalFiles) ||
      (completedBatchCountAfterBatch < job.totalBatches && completedFilesAfterBatch >= job.totalFiles)
    ) {
      throw new ConvexError({ code: "IMPORT_PLAN_INVALID", message: "Choose the vault again to restart this import." });
    }

    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "importVault", files: args.files },
    })) as Extract<OperationResult, { kind: "vaultImported" }>;
    if (
      job.strategy === "replace" &&
      job.completedBatches.length + 1 === job.totalBatches &&
      job.completedFiles + args.files.length === job.totalFiles
    ) {
      // Idempotent so a retry after storage succeeded but progress recording
      // failed still restores the private access map before completing.
      await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope,
        operation: { kind: "ensurePrivacy" },
      });
    }
    const recorded = await ctx.runMutation(internal.functions.files.recordVaultImportBatch, {
      jobId: args.jobId,
      actorUserId,
      workspaceId: args.workspaceId,
      sourceFingerprint: args.sourceFingerprint,
      batchIndex: args.batchIndex,
      filesProcessed: args.files.length,
      filesCreated: result.created.length,
      filesSkipped: result.skipped.length,
    });
    if (recorded === null) {
      throw new ConvexError({ code: "IMPORT_JOB_MISMATCH", message: "Choose the same vault again to resume." });
    }
    if (result.created.length > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.import",
        paths: result.created,
        details: {
          filesCreated: result.created.length,
          filesSkipped: result.skipped.length,
          bytesCreated: result.bytesCreated,
          batchIndex: args.batchIndex,
        },
      });
    }
    return recorded;
  },
});

/**
 * Upload one retryable batch from a locally selected Obsidian vault.
 *
 * Owner-only because a vault import can create non-Markdown attachments and a
 * large path tree. Bytes cross this action directly into the workspace bucket;
 * the control plane stores only the ordinary audit metadata below.
 */
export const importVaultBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "vaultImported" }>> => {
    if (args.files.length === 0 || args.files.length > MAX_VAULT_IMPORT_BATCH_FILES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: `Upload between 1 and ${MAX_VAULT_IMPORT_BATCH_FILES} files at a time.`,
      });
    }
    const batchBytes = args.files.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (batchBytes > MAX_VAULT_IMPORT_BATCH_BYTES) {
      throw new ConvexError({
        code: "IMPORT_BATCH_INVALID",
        message: "That upload batch is too large. Choose the vault again to retry in smaller pieces.",
      });
    }

    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "importVault", files: args.files },
    })) as Extract<OperationResult, { kind: "vaultImported" }>;

    if (result.created.length > 0) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "vault.import",
        paths: result.created,
        details: {
          filesCreated: result.created.length,
          filesSkipped: result.skipped.length,
          bytesCreated: result.bytesCreated,
        },
      });
    }
    return result;
  },
});

/**
 * Remove a passphrase lock, replacing an encrypted note with plaintext.
 *
 * **Not `writeNote`, deliberately.** `writeFile`'s own widening lets an
 * envelope replace an envelope naming the same recipients — an edit while
 * unlocked, a passphrase change — and refuses plaintext over an encrypted note
 * in every case, so that an ordinary Save can never silently turn a lock off.
 * This is the separate, narrower door for the one legitimate plaintext-over-
 * encrypted write: reachable only from an explicit "Remove encryption" action
 * in the console, never from the editor's own Save.
 *
 * `minimum: "editor"`, the same as `writeNote` — the passphrase is what gates
 * this, not the workspace role. Anyone who can already write this note and
 * who was given the passphrase some other way (`docs/decisions/encryption.md`:
 * "sharing a note does not share its passphrase") may remove the lock they
 * were told how to open; nobody who lacks the passphrase can produce a
 * plaintext body this console will accept, because there is nothing here that
 * could have decrypted the note to produce one.
 */
export const removeNoteEncryption = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "written" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "removeEncryption",
        path: args.path,
        text: args.text,
        expectedEtag: args.expectedEtag,
      },
    })) as Extract<OperationResult, { kind: "written" }>;

    // Paths and an outcome. Never the text, same as every other write here.
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.decrypt",
      paths: [result.path],
      details: { conflictCheck: result.conflictCheck },
    });
    return result;
  },
});

/** Create a folder. Requires `editor`. */
export const createDirectory = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: folderCreatedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "folderCreated" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "createFolder", path: args.path },
    })) as Extract<OperationResult, { kind: "folderCreated" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "folder.create",
      paths: [result.path],
    });
    return result;
  },
});

/** Move or rename a file or folder. Requires `editor`. */
export const moveEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "move", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.move",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Paste a copy at an explicit destination. Requires `editor`. */
export const copyEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "copy", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.copy",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Copy beside itself under a free "… copy" name. Requires `editor`. */
export const duplicateEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "duplicate", path: args.path },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.duplicate",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/**
 * Archive: move into `4-archive/<timestamp>/…`, recoverable by moving it back.
 *
 * This is the destructive-looking action the console offers first, precisely
 * because it is not destructive. Requires `editor`.
 */
export const archiveEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "archive", path: args.path },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.archive",
      paths: [result.from, result.to],
      details: { files: result.paths.length, recoverable: true },
    });
    return result;
  },
});

/**
 * Delete permanently. Requires `editor` **and** the literal confirmation
 * string, which the console only sends after the person has been told plainly
 * that the file cannot be recovered.
 *
 * Nothing this product controls is kept: no archive, and **the legacy
 * `.history/` snapshots for that path are purged too** — that last clause is the
 * one this comment used to imply and the code did not do. Nothing writes new
 * snapshots any more.
 *
 * What it cannot reach is the customer's own object versioning, which we tell
 * them to enable and cannot see or delete. `lib/fileOps.ts` has the full
 * argument, and `describeDeleteForever` is the sentence the console has to keep
 * true.
 */
export const deleteEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    confirmation: v.string(),
  },
  returns: deletedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "deleted" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "delete",
        path: args.path,
        confirmation: args.confirmation,
      },
    })) as Extract<OperationResult, { kind: "deleted" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.delete",
      paths: result.paths,
      details: { recoverable: false },
    });
    return result;
  },
});

/**
 * Change one note's visibility, through the privacy manifest. Requires
 * `owner` — see `setDirectoryVisibility` for why, learned the hard way.
 *
 * Setting a note to its folder's default removes the exception rather than
 * writing a redundant one — which is what keeps `privacy.md` a readable
 * statement of what is unusual, and what the tree's markers read.
 */
export const setNoteVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "setVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.note",
      paths: [result.path],
      details: { visibility: result.visibility, exception: result.exception },
    });
    return result;
  },
});

/**
 * Hand one note to a group, by name.
 *
 * The share dialog's verb. `setNoteVisibility` takes the two tiers and stays
 * that way — widening its validator would make every caller that sets a
 * visibility a way to mint a rule — so pointing a note at a group is its own
 * action, with its own audit line and its own proof that the group is real.
 *
 * **The name is resolved against THIS workspace before anything is written.**
 * Group names are globally unique but the authority is not: a name that exists
 * in somebody else's context must be as unusable here as one that exists
 * nowhere, and `groupByName` answers `null` for both. Writing an unresolvable
 * name would not leak — the engines read it as reaching nobody — but it would
 * put a rule in the customer's manifest that no owner can account for.
 *
 * Requires `owner`, like every other writer of `privacy.md`.
 */
export const setNoteGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The group's full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });

    // Tolerated on the way in and stripped once: the console renders the `@`
    // because that is what the manifest shows, and a caller pasting what they
    // see should not be a refusal. Stored without it, because the manifest's
    // own grammar supplies the `@`.
    const name = args.group.trim().replace(/^@/, "");
    const group = await ctx.runQuery(internal.functions.groups.groupByName, {
      workspaceId: args.workspaceId,
      name,
    });
    if (group === null) {
      throw new ConvexError({
        code: "GROUP_NOT_FOUND",
        message: "That group is not one of this context's.",
      });
    }

    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "setNoteGroup", path: args.path, group: group.name },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.note",
      paths: [result.path],
      details: { visibility: result.visibility, exception: result.exception },
    });
    return result;
  },
});

/**
 * Change a folder's default, which every note without an exception follows.
 * Requires `owner`.
 *
 * It said `editor` once, and that was a live breach: an invited editor
 * flipped private folders to `team` and read everything behind them —
 * deciding their own clearance, which is exactly the authority
 * `resetPrivacy`'s comment already reserved for the owner. All three
 * privacy-manifest writers now carry the same gate, and `lib/fileOps.ts`
 * refuses a non-`private` scope besides, so no future caller can reopen
 * this by getting one minimum wrong.
 */
export const setDirectoryVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "setFolderVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.folder",
      paths: [result.path],
      details: { visibility: result.visibility },
    });
    return result;
  },
});

/**
 * Write a working `privacy.md` over a missing or unreadable one.
 *
 * Owner-only, and the one operation here that is. Every other write is an
 * editor's to make; this one replaces the file that decides what an editor is
 * allowed to see at all, and an editor rewriting it would be deciding their own
 * clearance. `authorizeFileAccess` with `minimum: "owner"` is also what makes
 * the scope handed down `private`, which `resetPrivacyManifest` requires.
 *
 * It cannot touch a manifest that parses — see `lib/fileOps.ts` for why that
 * check, rather than this one, is the safety argument — and what it writes is
 * every folder `private`, so a person cannot use it to publish anything.
 */
export const resetPrivacy = action({
  args: { workspaceId: v.id("workspaces") },
  returns: privacyResetValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "privacyReset" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "resetPrivacy" },
    })) as Extract<OperationResult, { kind: "privacyReset" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "privacy.reset",
      paths: [result.path],
      // The folder *names* are metadata the audit log already records for every
      // other operation, and the count is what says how much of a map was
      // rebuilt. No rule is recorded because there is only one: private.
      details: {
        folders: result.folders.length,
        partial: result.partial,
        restored: result.backedUpTo !== null,
      },
    });
    return result;
  },
});
