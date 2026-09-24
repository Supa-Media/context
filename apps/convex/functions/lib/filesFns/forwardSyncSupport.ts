/**
 * The parts of the Google forward sync pass that touch neither `ctx` nor the
 * control plane: the job and result shapes, the fetch deadline, the error
 * classifier, and the shared calendar-day write.
 *
 * Split out of `functions/files.ts`, which keeps every step that records a
 * pass or mints a token.
 */

import {
  CalendarApiError,
  CalendarPaginationError,
} from "../../../../mcp/src/communications/calendar-google.js";
import {
  CalendarContributionConflictError,
} from "../../../../mcp/src/communications/calendarContributionStore.js";
import { ChatApiError } from "../../../../mcp/src/communications/googleChat/client.js";
import {
  ChatContributionConflictError,
} from "../../../../mcp/src/communications/googleChat/contributionStore.js";
import { ChatPaginationError } from "../../../../mcp/src/communications/googleChat/sync.js";
import type { FileStore } from "../fileOps";
import { GmailApiError } from "../../../../mcp/src/communications/gmailSync.js";
import type { Id } from "../../../_generated/dataModel";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
import { isCalendarDayNote } from "../../../../../packages/communications/src/calendar/index.js";
import type { OperationResult } from "./operationTypes";

/** Same deadline `functions/provisioning.ts` puts on the customer's endpoint. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` with a per-request deadline.
 *
 * Guarded rather than assumed, exactly as in `functions/provisioning.ts`: this
 * runs in the Convex action runtime and in `@edge-runtime/vm` under test, and a
 * missing timeout is a slower failure rather than a wrong one.
 */
export function timeoutFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  return globalThis.fetch(input, timeout ? { ...init, signal: timeout } : init);
}

/**
 * What `googleSync.googleForwardSyncJob` answered.
 *
 * Written out rather than inferred because the inference would run through
 * `internal.functions.googleSync`, which is the cycle every annotated handler
 * in this file exists to avoid.
 */
export type ForwardSyncJob =
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

export type ForwardSyncResult = Extract<OperationResult, { kind: "googleForwardSync" }>;

const GMAIL_RATE_LIMIT_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
]);

export class CalendarTimezoneMismatchError extends Error {
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
export function classifyForwardSyncError(error: unknown): { code: string; message: string } {
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
      message: "Gmail or storage took too long. The next scheduled pass resumes from the same place.",
    };
  }
  return {
    code: "GOOGLE_SYNC_FAILED",
    message: "This mailbox did not sync. The next scheduled pass resumes from the same place.",
  };
}

export async function writeSharedCalendarDay(
  store: FileStore,
  path: string,
  text: string | null,
): Promise<{ wrote: boolean; bytes: number }> {
  const retryableCollaborationError = (error: unknown): boolean => {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "CONFLICT" || code === "CONCURRENT_WRITE" || code === "BASE_MISSING" ||
      code === "GENERATION_MISMATCH" || code === "DOCUMENT_MISSING" || code === "DELETED";
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await store.get(path);
    const existingText = existing === null ? null : await existing.text();

    if (existingText !== null && !isCalendarDayNote(existingText)) {
      if (text === null) return { wrote: false, bytes: 0 };
      throw new Error("Calendar cannot replace a note the owner wrote in its destination folder");
    }
    if (text === null) {
      if (existing === null) return { wrote: false, bytes: 0 };
      if (collaborationSupported(store) && collaborationEligible(path, existingText ?? undefined)) {
        if (store.capabilities?.conditionalDelete !== true) {
          throw new Error("Calendar cannot delete a collaboration note without conditional deletion");
        }
        try {
          const current = await readCollaborationDocument(store, path);
          await tombstoneCollaborationDocument(store, path, {
            expectedEtag: current.etag,
            permanent: true,
          });
          return { wrote: true, bytes: 0 };
        } catch (error) {
          if (retryableCollaborationError(error)) continue;
          throw error;
        }
      }
      const deleted = await store.delete(path, {
        onlyIf: { etagMatches: existing.etag },
      });
      if (deleted !== null) return { wrote: true, bytes: 0 };
      continue;
    }
    if (existingText === text) return { wrote: false, bytes: 0 };
    if (existing !== null && collaborationSupported(store) && collaborationEligible(path, existingText ?? undefined)) {
      try {
        const current = await readCollaborationDocument(store, path);
        const replaced = await replaceCollaborationText(store, path, {
          documentId: current.documentId,
          expectedEtag: current.etag,
          text,
        });
        return { wrote: true, bytes: new TextEncoder().encode(replaced.text).byteLength };
      } catch (error) {
        if (retryableCollaborationError(error)) continue;
        throw error;
      }
    }
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
