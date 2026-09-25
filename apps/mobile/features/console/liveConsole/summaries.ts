import type { Id } from "@context/convex/_generated/dataModel";

/*
  The shapes the live console reads off Convex, and the two guards every read
  of them goes through. Moved out of `useLiveConsoleData.ts` unchanged.
*/

export interface WorkspaceSummary {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  kind: string;
  role: string;
  /** Where meetings land here, when the owner has chosen. Absent is the default. */
  meetingsFolder?: string;
  /**
   * When this context last changed, and when this person last caught up here.
   *
   * The two halves of the dot on its mark, kept apart because the rule that
   * combines them belongs in one place — `hasNewActivity` — rather than being
   * recomputed wherever a row is drawn.
   */
  activityAt?: number;
  activitySeenAt?: number;
  /**
   * The layout a setup flow last recorded — `para` or `custom`, absent where
   * neither flow got that far. `listMyWorkspaces` has always returned it.
   */
  structureTemplate?: string;
  /**
   * The mark this workspace draws, when its owner chose one. A photo is its
   * leaf; see `ConsoleContext.icon` for why the bytes are not on this row.
   */
  icon?: { kind: "photo"; leaf: string } | { kind: "emoji"; emoji: string };
  /** The pinned context. See `ConsoleContext.pinned` for what it changes here. */
  pinned?: boolean;
}

/**
 * The workspaces this account is actually *in*.
 *
 * Everything that subscribes per workspace has to be driven off this rather
 * than off the raw list, because the pinned context is reach without a
 * membership row: `listGrants`, `getStorageBinding` and
 * `listGoogleConnections` all go through `requireWorkspaceAccess` and throw
 * `WORKSPACE_NOT_FOUND` for it. Subscribing anyway would not break the console
 * — `usable()` turns a failed query into `undefined` — which is exactly why it
 * is worth naming: the damage would be three silently failing subscriptions per
 * paint, and a storage pip that reads "unknown" because the query errored
 * rather than because the bucket is quiet.
 */
export function memberOf(
  workspaces: readonly WorkspaceSummary[] | undefined,
): WorkspaceSummary[] {
  return (workspaces ?? []).filter((workspace) => workspace.pinned !== true);
}

export interface StorageBinding {
  provider: string;
  managed: boolean;
  /**
   * Optional, because a Dropbox binding has none of them — see the validator
   * on `getStorageBinding`. `maskedAccessKeyId` in particular is `undefined`
   * rather than an empty string, so that the console renders nothing instead
   * of a masked credential that does not exist.
   */
  endpoint?: string;
  region?: string;
  bucket?: string;
  rootPrefix?: string;
  maskedAccessKeyId?: string;
  forcePathStyle?: boolean;
  /** `dbid:…` for a Dropbox binding, absent for every other provider. */
  dropboxAccountId?: string;
  capabilities: { conditionalWrite: boolean };
  status: string;
  lastVerifiedAt?: number;
  lastError?: string;
  /** From the closed set in `functions/provisioning.ts`. See `storage/errors.ts`. */
  errorCode?: string;
  /**
   * What the last walk of this bucket counted, and whether it reached the end.
   *
   * All absent until a verification has looked — which is the state a brand-new
   * binding is in, and the state a binding whose probe failed stays in. Absent
   * is not zero, and `noteTotals.ts` is where that distinction is kept.
   */
  noteCount?: number;
  noteCountedAt?: number;
  noteCountTruncated?: boolean;
  /**
   * The verifier's word for what it found in the bucket — `empty`,
   * `existing-context`, `created`, `partial`, `failed`.
   *
   * Absent means nobody has looked, or a deployment older than the field, and
   * **never** "empty": `features/console/setup.ts` turns on that distinction,
   * because the difference between the two is a card offering to write folders
   * into somebody's live vault.
   */
  scaffoldReason?: string;
  scaffoldQueuedAt?: number;
  /**
   * Where the storage-layout migration got to. Absent until it has run through
   * us, which is the only state the console still offers it in.
   */
  storageLayoutState?:
    | "copying"
    | "copied"
    | "cleaning"
    | "conflict"
    | "unsupported"
    | "complete";
  storageLayoutAt?: number;
  /**
   * Whether the bucket has been *asked* where the migration got to, and by
   * which generation of the question. Absent state with both set is the real
   * "nobody has run it"; absent checked is "nobody has looked", which is not
   * something to offer on; and a stale version is an answer from the probe
   * that got a freshly scaffolded bucket wrong. `storageLayoutAnswerIsCurrent`
   * is the one place those three are told apart.
   */
  storageLayoutCheckedAt?: number;
  storageLayoutCheckedVersion?: number;
  /**
   * Load-bearing for Re-verify: the probe is queued, not awaited, so the pane
   * watches this field to know its outcome landed. See `storage/reverify.ts`.
   */
  updatedAt: number;
}

export interface GrantSummary {
  grantId: Id<"oauthGrants">;
  workspaceId: Id<"workspaces">;
  clientId: string;
  clientName?: string;
  scopes: string[];
  status: string;
  /**
   * Whether the row is the caller's own client, decided by the server.
   *
   * A context's `owner` is the only role shown anybody else's grants, so this
   * is `true` on every row for everybody else — and it is the server's answer
   * rather than a comparison made here, because the alternative is this file
   * being told a user id in order to re-derive something it was already sent.
   */
  isMine: boolean;
  lastUsedAt?: number;
}

export interface GoogleConnectionSummary {
  connectionId: Id<"googleConnections">;
  email: string;
  syncServices: { gmail: boolean; calendar: boolean; chat: boolean };
  syncStatus: string;
  /** How often this account is polled, and how the last poll went. */
  sync: {
    intervalMinutes: number;
    everSynced: boolean;
    cursorReady: boolean;
    catchingUp: boolean;
    lastAttemptAt?: number;
    nextDueAt?: number;
    lastFailureAt?: number;
    lastFailureCode?: string;
    lastFailure?: string;
  };
  lastSyncStartedAt?: number;
  lastSyncCompletedAt?: number;
  errorCode?: string;
  lastError?: string;
  gmail?: {
    backfillDays: number;
    folders: Array<"inbox" | "sent">;
    destinationFolder: string;
    destinationPath: string;
    historyCursorReady: boolean;
    lastSyncedAt?: number;
  };
  calendar?: {
    destinationFolder: string;
    destinationPath: string;
    syncCursorReady: boolean;
    lastSyncedAt?: number;
  };
  chat?: {
    destinationFolder: string;
    destinationPath: string;
    cursorCount: number;
    lastSyncedAt?: number;
  };
  syncRun?: {
    runId: Id<"googleSyncRuns">;
    mode: "backfill";
    services: Array<"gmail" | "calendar" | "chat">;
    status: "queued" | "running" | "complete" | "failed";
    requestedBackfillDays: number;
    totalUnits: number;
    completedUnits: number;
    itemsFound?: number;
    daysWithMail?: number;
    bytesWritten?: number;
    currentService?: "gmail" | "calendar" | "chat";
    currentUnit?: string;
    startedAt?: number;
    completedAt?: number;
    errorCode?: string;
    lastError?: string;
  };
}

/**
 * Convex hands back `undefined` while loading and an `Error` when a query threw.
 *
 * **Only true of `useQueries`.** `useQuery` re-throws a failed query during
 * render before any caller can look at it, so this guard is live code here and
 * would be dead code beside a `useQuery`. That is exactly what it was until the
 * subscriptions in this file moved across: see `./failure.ts`.
 */
export function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}
