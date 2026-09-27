import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The global name namespace, workspaces, and who is a member of one.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const workspaceTables = {
  /**
   * ONE global namespace shared by usernames and workspace slugs.
   *
   * `@lk` (a person) and `@shared-thing` (a workspace) are addressed
   * identically in `@name/path`, so they cannot be allowed to collide. Keeping
   * both kinds in a single table makes that structural: a claim is a row, and
   * the uniqueness check is one lookup rather than two that could race past
   * each other.
   *
   * `name` is always the normalized form (see `functions/lib/names.ts`).
   */
  names: defineTable({
    name: v.string(),
    kind: v.union(
      v.literal("user"),
      v.literal("workspace"),
      v.literal("group"),
    ),
    /** Set when `kind === "user"`. */
    userId: v.optional(v.id("users")),
    /** Set when `kind === "workspace"`. */
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * Set when `kind === "group"`.
     *
     * A group claims a row here for the same reason a workspace does: a privacy
     * rule names a person and a group with the same `@name` token, so the two
     * cannot be allowed to collide. Keeping the third kind in this table makes
     * that one lookup rather than three that could race past each other.
     */
    groupId: v.optional(v.id("workspaceGroups")),
    claimedBy: v.id("users"),
    claimedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"]),

  /**
   * A workspace is the unit that owns a context: one storage binding, one
   * privacy manifest, one audit trail, one set of grants.
   *
   * A personal context is a workspace created `kind: "personal"`, with
   * exactly one `owner` member — the person its slug names. It may gain more
   * members when that person shares it; sharing does not change what it is.
   * A shared context is created `kind: "shared"` and has no single personal
   * owner. There is deliberately no separate "personal context" table — see
   * CLAUDE.md, "The workspace model".
   */
  workspaces: defineTable({
    /** Normalized, globally unique, also present as a row in `names`. */
    slug: v.string(),
    displayName: v.string(),
    createdBy: v.id("users"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /**
     * Which starting layout was written into the bucket. Purely a record of
     * what onboarding laid down — the tools operate on paths, not on a fixed
     * taxonomy, a `custom` workspace is not second-class, and the owner is free
     * to rename or delete every one of these folders afterwards.
     *
     * Nothing reads this to decide what to write. `applyStructure` passes the
     * choice to the scaffolder directly and patches this field alongside, so a
     * value here can never cause a bucket write on some later, unrelated
     * verification. What actually happened to the bucket is recorded on the
     * storage binding, as `scaffoldReason`.
     */
    structureTemplate: v.union(v.literal("para"), v.literal("custom")),
    /**
     * The root folders the owner named, when they chose `custom`.
     *
     * Kept so the console can show what was laid down without listing the
     * bucket. Not authoritative: the bucket is. If they rename a folder
     * afterwards — which they may, freely — this goes stale, and that is fine.
     */
    customFolders: v.optional(
      v.array(v.object({ folder: v.string(), description: v.string() })),
    ),
    /**
     * When something worth mentioning last happened in this context.
     *
     * The dot on another workspace's mark, and nothing else. It is the
     * timestamp of the newest line in that context's `activity.md`, written by
     * whichever side recorded it — so "has @seyi moved since I last looked"
     * is answerable from the row the console already reads, without opening
     * anybody's bucket.
     *
     * **A number, not a count.** A count would have to be a count of what
     * *this* reader may see, which differs per member and cannot live on a
     * shared row; the reader's own `activitySeenAt` turns this into a boolean
     * on their side, and the honest number is one press away in the context
     * itself.
     *
     * Absent for a context nothing has been recorded in. Monotonic: a writer
     * that arrives late never walks it backwards.
     *
     * **Owner-only**, and `activityTeamAt` is the rest of the story.
     */
    activityAt: v.optional(v.number()),
    /**
     * The same, counting only the lines written at `team` tier.
     *
     * A member who is not the owner is served this one instead, because
     * `activityAt` would otherwise hand them the exact time of a change they
     * may not see — a dot that says "the owner did something private at
     * 14:32". The file itself refuses them that, `list_changes` filters it and
     * the tree hides it; a mark in the switcher must not be the one place it
     * leaks. See `docs/decisions/privacy-and-sharing.md` on the two gates:
     * this is the event-time flag, the coarser of them, and it is the right
     * one here because nothing per-reader can be computed from a row every
     * member reads.
     */
    activityTeamAt: v.optional(v.number()),
    /**
     * Where a meeting recorded into this context lands by default.
     *
     * Absent is `MEETINGS_FOLDER` — `0-inbox/meetings` — which is what every
     * context had before this field existed and what a context that has never
     * set one still has. Stored rather than derived because it is the one
     * capture destination a person could not change: mail, calendars and Chat
     * each carry an editable folder per connection, and meetings carried a
     * constant interpolated into a sentence.
     *
     * **This names a folder, not whether the question is asked.** The
     * destination sheet still asks before every recording — that rule is
     * `features/meetings/destination.ts`'s and is untouched. What this changes
     * is which folder the first offer points at.
     */
    meetingsFolder: v.optional(v.string()),
    /**
     * What this workspace draws in its mark, when its owner has chosen
     * something better than the first letter of its slug.
     *
     * Absent is the default and always will be: the mark falls back to the
     * letter, which is what every workspace drew before this field existed, so
     * nothing here needs a migration or a backfill.
     *
     * **A photo is a leaf, never bytes.** The image itself lives in the
     * workspace's own bucket, in the opaque image store under `IMAGE_PREFIX`,
     * and this records only the name it was written under. The control plane
     * holds metadata and never note content (`CLAUDE.md` #1), and a
     * photograph somebody put in their context is content — storing it here
     * would mean a customer who revokes our credential leaves without it.
     *
     * An emoji is not content. It is a handful of code points chosen from a
     * list we ship, it means nothing outside this row, and there is nothing to
     * leave with — so it sits here beside `displayName`, which is the same kind
     * of fact about the same workspace.
     */
    icon: v.optional(
      v.union(
        v.object({ kind: v.literal("photo"), leaf: v.string() }),
        v.object({ kind: v.literal("emoji"), emoji: v.string() }),
      ),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  /**
   * Whether this workspace's bucket-backed website is live.
   *
   * The bucket remains authoritative for every page and route. This row is
   * only the explicit lifecycle switch the bucket cannot express by merely
   * containing a folder. Disabled rows are retained so an idempotent disable
   * has one answer and never needs to delete customer files.
   */
  websiteStates: defineTable({
    workspaceId: v.id("workspaces"),
    state: v.union(v.literal("enabled"), v.literal("disabled")),
    enabledAt: v.optional(v.number()),
    enabledBy: v.optional(v.id("users")),
    /**
     * Set only after the enable path has verified the starter homepage.
     * Legacy enabled rows without this marker get one absent-only repair;
     * later intentional homepage deletion is left alone.
     */
    starterEnsuredAt: v.optional(v.number()),
    /**
     * Set once `privacy.md` has been given its `website` folder rule (or
     * found to have one already). Enabled rows from before the website read
     * `privacy.md` get one absent-only repair; a rule the owner later changes
     * is theirs and is never rewritten.
     */
    publicationRuleEnsuredAt: v.optional(v.number()),
    /** Monotonic fence: an older bucket scan may never replace a newer one. */
    routeGeneration: v.optional(v.number()),
    routeReconciledGeneration: v.optional(v.number()),
    routeReconciledAt: v.optional(v.number()),
    routeAttemptedAt: v.optional(v.number()),
    /** Set while an unpublished change may have narrowed a public route. */
    routeUnsafeGeneration: v.optional(v.number()),
    /** Current and one grace release; page bytes remain in the customer bucket. */
    publishedReleaseId: v.optional(v.string()),
    previousReleaseId: v.optional(v.string()),
    /** When someone last pressed Publish and a release landed. */
    publishedAt: v.optional(v.number()),
    /**
     * Moves whenever what visitors are served may have: a publish, or a
     * restriction applied without one. The homepage caches by it.
     */
    siteRevision: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_state_attempted", ["state", "routeAttemptedAt"]),

  /**
   * Disposable website routing metadata, rebuilt from the workspace bucket.
   * It deliberately holds no Markdown: a matching etag is checked against the
   * bucket before runtime serving, and deleting every row loses no authorship.
   */
  websiteRouteIndex: defineTable({
    workspaceId: v.id("workspaces"),
    objectKey: v.string(),
    routePath: v.union(v.string(), v.null()),
    lookupKey: v.optional(v.string()),
    sourceEtag: v.string(),
    /** Immutable fallback page in the customer's `.context/` namespace. */
    releaseId: v.optional(v.string()),
    releasePageId: v.optional(v.string()),
    status: v.union(
      v.literal("live"),
      v.literal("draft"),
      v.literal("problem"),
    ),
    audience: v.union(v.literal("public"), v.literal("members")),
    title: v.union(v.string(), v.null()),
    description: v.union(v.string(), v.null()),
    nav: v.union(v.number(), v.null()),
    problems: v.array(v.object({ code: v.string(), message: v.string() })),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_object", ["workspaceId", "objectKey"])
    .index("by_workspace_lookup", ["workspaceId", "lookupKey"]),

  /**
   * Membership carries an explicit role. Read access and write access to
   * someone else's context are different grants; write is never implied.
   *
   * owner  — full control, including storage rebinding and revoking anyone's grant
   * editor — read + write notes
   * member — read only
   */
  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.number(),
    /**
     * When this person last looked at this context's activity.
     *
     * One timestamp per person per workspace, and deliberately not a per-note
     * read state: the feature it serves is a line across a list and a dot on a
     * row, and neither needs to know which of forty notes somebody's eye
     * stopped on. A counter would need one row per note per member and would
     * still be wrong the moment two devices disagreed.
     *
     * Here rather than in the bucket because it is **about the reader, not
     * about the context**. The bucket holds what happened; who has caught up
     * with it is control-plane metadata, and writing it into somebody's own
     * Markdown would put one member's reading habits into a file every other
     * member can export.
     *
     * Absent means "has never looked", which reads as everything being new —
     * the correct answer for a member who just joined.
     */
    activitySeenAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),
};
