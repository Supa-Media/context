/**
 * Advanced: background storage work, this context's audit trail, and the key export that keeps
 * encryption honest about `CLAUDE.md`'s first non-negotiable.
 *
 * "Advanced" is kept as the word on purpose, for the reason it was chosen: it
 * reliably means "not for me" to most people, which is right for a section
 * whose rows expose operational detail, a raw activity log, and a control that
 * hands somebody AES key material in the clear.
 *
 * Pure and React-free, like `members.ts` and `shares.ts`.
 */

import type { ConsoleFailure } from "../failure";

/* -------------------------------------------------------------------------- */
/*                               the audit trail                              */
/* -------------------------------------------------------------------------- */

/**
 * One row of `apps/convex/functions/audit.ts`'s `listEvents`, exactly as the
 * control plane returns it.
 *
 * `details` is read by exactly one thing in this console — `auditDetailLine`,
 * for exactly one action — and that narrowness is the point. `audit.ts`'s own
 * header explains at length why even the allow-listed fields it carries are
 * subtle: a count can be a subtraction, a scope can be a permission, a
 * visibility can be an existence oracle. Rendering this map generally would
 * publish every one of those the day the server added it.
 */
export interface ConsoleAuditEvent {
  eventId: string;
  /**
   * The acting identity, resolved to something a human recognizes where the
   * server could. `audit.ts`'s own header: "it names the acting identity, not
   * a scope" — an id nobody can read is not an answer to "who did this".
   */
  actorUserId?: string;
  actorEmail?: string;
  /** An OAuth client's id, when an AI app rather than a signed-in person acted. */
  actorClientId?: string;
  action: string;
  paths: string[];
  at: number;
  details?: Record<string, string | number | boolean | null>;
}

export interface AuditView {
  events: ConsoleAuditEvent[];
  loading: boolean;
  /**
   * Set when `listEvents` came back as an error rather than a list — the same
   * discipline every other per-context view in this console follows, and for
   * the same reason: `useAdvanced` subscribes with `useQueries`, never
   * `useQuery`, so a thrown query does not take the console down.
   */
  failure: ConsoleFailure | null;
  /** Shown instead of the trail when it is absent for a real reason. See `canReadAuditTrail`. */
  readOnlyReason?: string;
}

/**
 * Whether a role may read this context's audit trail **through the console**.
 *
 * `listEvents` itself is member-readable on the backend, deliberately — its
 * own header says the point of a trail is that the people whose notes are
 * involved can see what touched them, `paths` is gated to the reader's own
 * clearance or their own rows (`readsEveryPath` in `apps/convex/functions/
 * audit.ts`), and `details` is allow-listed per action
 * (`MEMBER_VISIBLE_DETAIL_ACTIONS`) precisely so that read can be safe. See
 * `docs/decisions/privacy-and-sharing.md`'s **"A row's paths are the reader's
 * own clearance, or the reader's own hands"** for the server-side fix and
 * what it cost — this comment used to describe that fix as still open on the
 * server; it landed, and this gate did not go away with it.
 *
 * This gate now does **independent** work rather than standing in for the
 * server one. Even with `paths` closed, a member reading the trail still sees
 * every row's *incidence* — action, actor, and timestamp, ungated by design,
 * named in that same doc section as a residual signal — and whatever
 * `details` the allow-list publishes. Both are weaker than a path, but they
 * are still more than this console currently chooses to hand a non-owner in
 * a settings panel, so the gate stays at `owner` until a product decision
 * says a member should see the trail's incidence here too. Loosening it is a
 * UI choice now, not a race against an open server-side leak — and is not
 * this change.
 */
export function canReadAuditTrail(role: string | undefined): boolean {
  return role === "owner";
}

/**
 * Human words for the actions this build recognises.
 *
 * Not exhaustive by design, and does not need to be: `auditActionLabel` falls
 * back to the server's own name for anything not listed here, so a new action
 * added to `apps/convex` reads as *some* activity from the day it ships rather
 * than disappearing from the trail or crashing on an unrecognised value.
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  "file.create": "Created a note",
  "file.write": "Edited a note",
  "file.delete": "Deleted a note",
  "file.decrypt": "Removed a note's passphrase lock",
  "file.move": "Moved a note",
  "file.copy": "Copied a note",
  "file.duplicate": "Duplicated a note",
  "file.archive": "Archived a note",
  "folder.create": "Created a folder",
  "workspace.structure_applied": "Set up the PARA folders",
  "visibility.note": "Changed a note's visibility",
  "visibility.folder": "Changed a folder's visibility",
  "member.joined": "Joined this context",
  "member.left": "Left this context",
  "member.invited": "Invited somebody",
  "member.removed": "Removed somebody",
  "member.role_changed": "Changed somebody's role",
  "invitation.revoked": "Withdrew an invitation",
  "share.created": "Shared a note with somebody",
  "share.revoked": "Revoked a shared link",
  "share.team.created": "Made a link for this context's members",
  "share.link.created": "Made an unlisted link",
  "grant.created": "Connected an AI app",
  "grant.revoked": "Revoked an AI app",
  "oauth.authorized": "Authorised an AI app",
  "privacy.reset": "Reset the privacy manifest",
  "search.fast_enabled": "Turned fast search on",
  "search.fast_disabled": "Turned fast search off",
  "storage.provisioned": "Connected storage",
  "storage.disconnected": "Disconnected storage",
  "storage.rekeyed": "Rotated the storage credential",
  "storage.reverify_requested": "Re-verified storage",
  "storage.provision_requested": "Requested storage",
  "storage.provision_failed": "A storage connection failed",
  "storage.provision_dismissed": "Dismissed a storage offer",
  "ingestion.captured": "Captured an email",
  "ingestion.settings.updated": "Changed the email ingestion rules",
  "mail.disconnected": "Disconnected mail",
  "mail.rekeyed": "Rotated a mail credential",
  "google_sync_destination_updated": "Changed a Google sync destination",
  "google_sync_interval_updated": "Changed how often Google syncs",
  "google_sync_wrote": "Synced mail into this context",
  "meetings.folder_set": "Changed where meetings land",
  "encryption.export": "Exported this context's encryption keys",
  "encryption.rekeyed": "Rotated an encryption key",
  "plugin.network": "A plugin reached the internet",
};

/**
 * The one action whose `details` this console renders, and the exact keys.
 *
 * ## Why a detail line exists at all, and why only this one
 *
 * A plugin's network request is the only audited event whose *subject is not
 * in the row*. "Edited a note" names the note in `paths`; "Connected an AI
 * app" names the app in its label. `plugin.network` carries no path by
 * construction — there is no note involved — so the row read
 * *"plugin network · you · 2 minutes ago"* and answered none of the three
 * questions somebody opens an audit trail to ask: **which plugin, reaching
 * what, and what came back.**
 *
 * That is not a cosmetic gap. A grant to reach `www.bible.com` is the most
 * consequential thing this console hands a plugin, the card promises it is
 * "brokered, audited and revocable", and the audited half was unreadable. The
 * control plane has recorded all four fields since the egress service landed
 * and hands them to an owner already (`readsEveryDetail` in
 * `apps/convex/functions/audit.ts`); only the drawing was missing.
 *
 * ## Why a map of keys rather than "render the details"
 *
 * Because the alternative publishes whatever the server adds next, forever,
 * with nobody re-reading this file. The keys are named here, in order, and a
 * key that is not named is not drawn — so a `details` that one day carries a
 * response body, a token, a header or a full URL renders exactly as much as it
 * does today, which is nothing.
 *
 * **What is deliberately absent:** the URL's path and query (the host is the
 * grant's unit and a path is what the plugin was reading), any request or
 * response body, and any header. `recordRuntimeAudit` never stores those, and
 * this list is the second lock rather than a restatement of the first.
 */
const RENDERED_DETAILS: Readonly<Record<string, readonly string[]>> = {
  "plugin.network": ["pluginId", "host", "method", "status"],
};

/**
 * How many characters of one detail value reach the screen.
 *
 * `method` is the one field of the four a *plugin* supplies — `host` is
 * re-derived from the parsed URL by the server, `pluginId` comes from the
 * session, `status` from the broker's own response — so it is bounded hardest.
 * All four are bounded anyway, for the reason every other piece of third-party
 * text in this console is: a cap the producer applies to itself is not a cap.
 */
const DETAIL_CAPS: Readonly<Record<string, number>> = {
  pluginId: 60,
  host: 120,
  method: 12,
  status: 6,
};

/**
 * The row's own detail line, or `null` when there is nothing to say.
 *
 * Reads only the keys `RENDERED_DETAILS` names for this action, in that order,
 * and only where the value is a string or a finite number. A boolean, a null,
 * an object or a missing key is dropped rather than printed — `"null"` under a
 * row is worse than a shorter line, and an object would stringify to
 * `[object Object]`.
 *
 * Whitespace is flattened, because these values become one line among several
 * in a card and a newline inside one would draw as an extra line of audit
 * trail that nothing recorded.
 */
export function auditDetailLine(event: ConsoleAuditEvent): string | null {
  const keys = RENDERED_DETAILS[event.action];
  if (keys === undefined) return null;
  const details = event.details;
  if (details === undefined || details === null) return null;

  const parts: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(details, key)) continue;
    const value = details[key];
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : null;
    if (text === null) continue;
    const bounded = text.replace(/\s+/g, " ").trim().slice(0, DETAIL_CAPS[key] ?? 60);
    if (bounded === "") continue;
    parts.push(bounded);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A row's own words, for an action this build recognises, and the server's
 * raw name — dots and underscores turned to spaces, never hidden — for one it
 * does not.
 *
 * The same closed-set-read-openly rule `fastSearchStateOf` and `describeScopes`
 * already follow in this console: a control plane newer than this bundle can
 * record an action this build has never heard of, and the honest response is
 * to print it rather than to drop the row or crash.
 */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

/**
 * The name on the row: an email, an OAuth client's id, or a neutral sentence —
 * never a raw user id, which tells a reader nothing and looks like a bug.
 *
 * `actorEmail` is absent, rather than the row's own `actorUserId` field, when
 * the acting user no longer exists — `listEvents` resolves the id to a person
 * at read time and simply has nobody to resolve it to. That is worth its own
 * sentence rather than folding into the "no actor at all" case below: the
 * event still names *who*, it is just that they are gone.
 */
export function auditActorLabel(event: ConsoleAuditEvent): string {
  const email = event.actorEmail?.trim();
  if (email !== undefined && email.length > 0) return email;
  const clientId = event.actorClientId?.trim();
  if (clientId !== undefined && clientId.length > 0) return clientId;
  if (event.actorUserId !== undefined) return "Someone no longer on this context";
  return "Context itself";
}

/* -------------------------------------------------------------------------- */
/*                                 key export                                 */
/* -------------------------------------------------------------------------- */

/** One generation's key, in the clear. Radioactive: never logged, never cached. */
export interface KeyExportEntry {
  generation: string;
  alg: string;
  key: string;
}

/**
 * The versioned document `docs/decisions/encryption.md`'s "Revocation and
 * export" section specifies — the artifact that, together with the customer's
 * own bucket, is a complete context with or without us.
 */
export interface KeyExportDocument {
  v: 1;
  workspace_id: string;
  exported_at: string;
  current: string;
  keys: KeyExportEntry[];
  envelope: { version: number; alg: string; spec: string };
}

/** What `exportEncryptionKeys` actually returns: material in the clear, unformatted. */
export interface RawKeyExport {
  current: string;
  keys: Array<{ generation: string; material: string }>;
}

/**
 * Build the versioned document from the control plane's raw answer.
 *
 * The console formats it rather than the backend returning it pre-wrapped,
 * because the `v` / `workspace_id` / `exported_at` / `envelope` wrapper is
 * presentation and provenance, not authorization — nothing about who may call
 * `exportEncryptionKeys` or what it discloses depends on how the JSON around
 * the key material is shaped. `apps/mcp/src/encryption.js`'s
 * `renderKeyExport` builds the gateway's own copy of the same shape from the
 * same raw answer, independently, which is what the decryptor's own test
 * suite depends on staying true.
 */
export function buildKeyExportDocument(
  workspaceId: string,
  raw: RawKeyExport,
  now: number,
): KeyExportDocument {
  return {
    v: 1,
    workspace_id: workspaceId,
    exported_at: new Date(now).toISOString(),
    current: raw.current,
    keys: raw.keys.map((entry) => ({
      generation: entry.generation,
      alg: "A256GCM",
      key: entry.material,
    })),
    envelope: { version: 1, alg: "A256GCM", spec: "docs/decisions/encryption.md" },
  };
}

/**
 * The export action a context's owner is offered.
 *
 * Absent — the whole property — for anyone who is not the owner, and in the
 * demo: `exportEncryptionKeys` is owner-only on the backend
 * (`authorizeEncryptionExport`), so the same rule `StorageActions` states
 * applies here too. `export` resolves to `null` for a context that has never
 * encrypted a note — there is no key to protect anybody from losing — and
 * rejects for a real refusal (rate-limited, signed out), which the caller
 * turns into words with `describeKeyExportFailure`.
 */
export interface KeyExportAction {
  export: () => Promise<KeyExportDocument | null>;
}

export interface KeyExportFailure {
  headline: string;
  next?: string;
}

/** The `code` on a thrown `ConvexError`, when there is one. */
function errorCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    const code = (data as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * A failed export, turned into something a person can act on.
 *
 * `RATE_LIMITED` names the actual limit — five exports per rolling day, spent
 * per context rather than per session (`docs/decisions/encryption.md`) —
 * rather than a generic "try again", because an owner mid-recovery-workflow is
 * exactly who this line is for.
 */
export function describeKeyExportFailure(error: unknown): KeyExportFailure {
  switch (errorCodeOf(error)) {
    case "INSUFFICIENT_ROLE":
      return {
        headline: "Only an owner can export this context's encryption keys",
        next: "Ask an owner of this context to export them.",
      };
    case "RATE_LIMITED":
      return {
        headline: "Too many exports just now",
        next: "This context allows five exports a day. Wait and try again.",
      };
    case "WORKSPACE_NOT_FOUND":
      return {
        headline: "This context is no longer available to you",
        next: "You may have been removed from it. Pick a different one.",
      };
    case "NOT_AUTHENTICATED":
      return { headline: "You are signed out", next: "Sign in and try again." };
    default:
      return {
        headline: "That did not work",
        next: "Try again in a moment.",
      };
  }
}

/**
 * Deleting a workspace, as the console offers it.
 *
 * Absent — the whole property — for anybody who is not an owner, and in the
 * demo: `account.deleteWorkspace` is owner-only, so the rule `KeyExportAction`
 * above follows applies here too, and more so. `blocked` is the other half:
 * a *present* action that this particular workspace must not use says why in
 * a sentence, instead of drawing a field and a button whose only outcome is
 * a refusal from the server.
 */
export interface WorkspaceDeletion {
  /** The name that has to be typed to confirm, without its `@`. */
  slug: string;
  /** Why this workspace cannot be deleted here, or `null` when it can. */
  blocked: string | null;
  /** Hands the typed name to the server, which checks it independently. */
  delete: (confirmSlug: string) => Promise<void>;
}

/**
 * Why deleting this workspace is refused, or `null` when it is not.
 *
 * Two refusals, and both are the server's — restated here so the console can
 * say them before the press rather than after it. Neither is a place to be
 * clever: an unanswered question **blocks**, because both inputs arrive a beat
 * after the first paint and a card that treated `undefined` as "fine" would
 * offer deletion for exactly the workspace it exists to refuse.
 */
export function deletionBlockedReason(input: {
  kind: string | undefined;
  storageIsManaged: boolean | undefined;
}): string | null {
  if (input.kind === undefined || input.storageIsManaged === undefined) {
    return "Checking what this workspace is before offering to delete it.";
  }
  if (input.kind !== "shared") {
    // A personal workspace's name is the person's own username and its capture address is
    // live on the apex. Releasing that is account deletion's business.
    return "A personal workspace is deleted with the account it belongs to. Delete the account to release its name.";
  }
  if (input.storageIsManaged) {
    return "This workspace's notes are in storage we run, and moving them out to a bucket you own is not built yet. Deleting it here would leave them somewhere you cannot reach, so it is refused until that lands.";
  }
  return null;
}

/**
 * Whether the typed confirmation matches the name.
 *
 * The same shapes the server accepts (`account.deleteWorkspace`): trimmed,
 * lowercased, and a leading `@` dropped — because the name is shown as
 * `@acme-eng` everywhere in this console, so that is what people copy.
 */
export function deletionConfirmed(typed: string, slug: string): boolean {
  return typed.trim().toLowerCase().replace(/^@/, "") === slug;
}

/** A refused deletion, in words somebody can act on. */
export function describeDeleteWorkspaceFailure(error: unknown): KeyExportFailure {
  switch (errorCodeOf(error)) {
    case "INSUFFICIENT_ROLE":
      return {
        headline: "Only an owner can delete this workspace",
        next: "Ask an owner to do it.",
      };
    case "CONFIRMATION_MISMATCH":
      return {
        headline: "That is not this workspace's name",
        next: "Nothing was deleted. Type the name exactly as it is shown.",
      };
    case "PERSONAL_CONTEXT":
      return {
        headline: "A personal workspace is deleted with its account",
        next: "Delete the account from Settings to release its name.",
      };
    case "MANAGED_MIGRATION":
      return {
        headline: "A move into storage we run is under way",
        next: "Let it finish or cancel it first, then delete this workspace.",
      };
    case "MANAGED_STORAGE":
      return {
        headline: "This workspace is on storage we run",
        next: "Moving its notes to a bucket you own is not built yet, so deleting it is refused until it is.",
      };
    case "WORKSPACE_NOT_FOUND":
      return {
        headline: "This workspace is no longer available to you",
        next: "It may already be gone. Pick a different one.",
      };
    case "NOT_AUTHENTICATED":
      return { headline: "You are signed out", next: "Sign in and try again." };
    default:
      return { headline: "That did not work", next: "Try again in a moment." };
  }
}

export interface AdvancedView {
  moves: DurableMoveView;
  audit: AuditView;
  /**
   * Absent for anybody who is not an owner of this workspace, and in the
   * demo. Present-but-`blocked` is a different state — see `WorkspaceDeletion`.
   */
  deletion?: WorkspaceDeletion;
  /**
   * Absent where the server would refuse it — a non-owner, no context
   * selected, and the demo. See `KeyExportAction`.
   */
  keyExport?: KeyExportAction;
}

export interface DurableMoveJob {
  jobId: string;
  status: "queued" | "running" | "complete" | "failed";
  phase?: "copying" | "deleting";
  completed?: number;
  total?: number;
  updatedAt: number;
}

export interface DurableMoveView {
  jobs: DurableMoveJob[];
  loading: boolean;
  failure: ConsoleFailure | null;
  readOnlyReason?: string;
}

/** One short, path-free sentence for a background folder move. */
export function describeMoveProgress(job: DurableMoveJob): {
  headline: string;
  detail: string;
} {
  if (job.status === "complete") {
    return { headline: "Large folder move complete", detail: "Physical storage is in sync." };
  }
  if (job.status === "failed") {
    return {
      headline: "Large folder move paused",
      detail: "Paused safely; try the move again when storage is reachable.",
    };
  }
  if (
    job.phase !== undefined &&
    job.completed !== undefined &&
    job.total !== undefined &&
    job.total > 0
  ) {
    const percent = Math.min(99, Math.floor((job.completed / job.total) * 100));
    const phase = job.phase === "copying" ? "Copying safely" : "Cleaning up the original";
    return {
      headline: "Moving a large folder",
      detail: `${phase} · ${job.completed} of ${job.total} · ${percent}%`,
    };
  }
  return {
    headline: "Moving a large folder",
    detail: job.status === "queued" ? "Waiting to start" : "Preparing safely",
  };
}
