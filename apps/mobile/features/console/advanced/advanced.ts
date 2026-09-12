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
 * `details` is not rendered by anything in this console today — that module's
 * own header explains at length why even the allow-listed fields it carries
 * are subtle (a count can be a subtraction, a scope can be a permission) — so
 * this file does not read it, and the type exists only so a future surface can
 * without re-deriving the shape.
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
  "encryption.export": "Exported this context's encryption keys",
  "encryption.rekeyed": "Rotated an encryption key",
};

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

export interface AdvancedView {
  moves: DurableMoveView;
  audit: AuditView;
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
