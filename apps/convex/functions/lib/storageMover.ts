/**
 * Handing one page of a whole-bucket move, or of the managed-storage
 * encryption walk, to the gateway's mover, so the files go bucket to bucket
 * (or are sealed in place) inside Cloudflare and never through this
 * deployment (owner, 2026-10-14: "we should not be downloading items into
 * Convex and back").
 *
 * The switch is `STORAGE_MOVER_ORIGIN`, the gateway's origin. Unset, every
 * page runs in the action as before (`migrationRun.ts`), which is what a
 * self-hosted deployment without the variable gets, and the brake if the
 * mover misbehaves.
 *
 * The request carries the gateway secret and a ticket, and nothing else: the
 * mover spends the ticket at `/gateway/mover/open` and gets the buckets back
 * from `managedProvisioning.openMoverPage`. The answer is counts, a cursor and
 * the names of files left behind; a failure is one of the codes the action
 * already retries or ends on.
 */

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { hashToken } from "./crypto";
import type { NoteIdItem } from "./nodes/noteIds";
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "./gatewayAuth";
import { MOVER_PAGE_TIMEOUT_MS } from "./managedProvisioningFns/constants";
import type { MigrationPageResult } from "./managedProvisioningFns/migrationRun";

type TicketPhase = Exclude<Doc<"moverTickets">["phase"], "carry">;
/**
 * The job a ticket names. `mintPage` checks that exactly one is set, and that
 * a job's own phases carry its own fields, so a loose type here is safe.
 */
type TicketFor = {
  migrationId?: Id<"managedStorageMigrations">;
  walkRunId?: number;
  idRunId?: number;
  idItems?: NoteIdItem[];
  /** The old-copy cleanup (`lib/cleanup/`): its run, and the keys a delete page may remove. */
  cleanupRunId?: number;
  cleanupKeys?: string[];
};

export const STORAGE_MOVER_ORIGIN_ENV_VAR = "STORAGE_MOVER_ORIGIN";
const MOVER_PAGE_PATH = "/internal/mover/page";
const FAILURE_CODES = new Set(["OBJECT_TOO_LARGE", "VERIFY_FAILED", "SOURCE_UNAVAILABLE", "COPY_FAILED"]);

/** The mover's origin, or `null` to run pages here. Only https, or loopback for development. */
export function storageMoverOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[STORAGE_MOVER_ORIGIN_ENV_VAR]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return null;
  return url.origin;
}

/** A walk failure's own code, as the gateway's walk names it; never text. */
const WALK_CODE = /^[A-Z_]{3,40}$/;

function readResult(body: unknown): MigrationPageResult | "stale" {
  if (!body || typeof body !== "object") throw new Error("COPY_FAILED");
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    if (answer.error === "STALE") return "stale";
    throw new Error(typeof answer.error === "string" && FAILURE_CODES.has(answer.error) ? answer.error : "COPY_FAILED");
  }
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (!count(answer.copied) || !count(answer.changes) || !count(answer.processed)) throw new Error("COPY_FAILED");
  const nextCursor = typeof answer.nextCursor === "string" && answer.nextCursor !== "" ? answer.nextCursor : null;
  const skipped = Array.isArray(answer.skipped)
    ? answer.skipped.filter((key): key is string => typeof key === "string").slice(0, 1_000)
    : [];
  return {
    copied: answer.copied as number,
    changes: answer.changes as number,
    processed: answer.processed as number,
    nextCursor,
    skipped,
  };
}

/**
 * Mint a ticket for one page, hand it to the mover, and return the mover's
 * answer as it came: `null` when the request never got an answer (unreachable,
 * too slow, or not a 200), which each caller treats as a page that failed.
 * The ticket is dropped afterwards whatever happened; a spent one is gone
 * already.
 */
async function handToMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  page: TicketFor & { phase: TicketPhase; expectedCursor?: string },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<unknown> {
  const secret = (options.env ?? process.env)[GATEWAY_SECRET_ENV_VAR];
  if (!secret) return null;
  const ticket = randomOpaqueToken();
  const hashedTicket = await hashToken(ticket);
  await ctx.runMutation(internal.functions.storageMover.mintPage, {
    hashedTicket,
    workspaceId,
    ...(page.migrationId === undefined ? {} : { migrationId: page.migrationId }),
    ...(page.walkRunId === undefined ? {} : { walkRunId: page.walkRunId }),
    ...(page.idRunId === undefined ? {} : { idRunId: page.idRunId, idItems: page.idItems }),
    ...(page.cleanupRunId === undefined
      ? {}
      : { cleanupRunId: page.cleanupRunId, ...(page.cleanupKeys === undefined ? {} : { cleanupKeys: page.cleanupKeys }) }),
    phase: page.phase,
    ...(page.expectedCursor === undefined ? {} : { expectedCursor: page.expectedCursor }),
    now: Date.now(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVER_PAGE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(`${origin}${MOVER_PAGE_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      return null;
    }
    if (response.status !== 200) return null;
    return (await response.json().catch(() => null)) ?? null;
  } finally {
    clearTimeout(timer);
    // Spent tickets are already gone; this drops one the mover never opened.
    await ctx.runMutation(internal.functions.storageMover.dropPage, { hashedTicket }).catch(() => undefined);
  }
}

/**
 * Run the migration's current page on the mover. `null` when the page was
 * already taken over (the row moved on before the mover opened it), which is
 * the same no-op a stale page is here. Throws one of the action's codes
 * otherwise; an unreachable mover is `COPY_FAILED`, retried like any page.
 */
export async function runMigrationPageOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  migration: Doc<"managedStorageMigrations">,
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<MigrationPageResult | null> {
  if (migration.phase === "count") throw new Error("COPY_FAILED");
  const body = await handToMover(
    ctx,
    workspaceId,
    { migrationId: migration._id, phase: migration.phase, expectedCursor: migration.cursor },
    origin,
    options,
  );
  if (body === null) throw new Error("COPY_FAILED");
  const result = readResult(body);
  return result === "stale" ? null : result;
}

export type WalkPagePhase = "seal" | "check" | "unseal" | "confirm";
export type WalkPageOutcome =
  | { kind: "done"; nextCursor: string | null; done: number }
  | { kind: "stale" }
  | { kind: "unanswered" }
  | { kind: "failed"; code: string };

/**
 * Run one page of the encryption walk on the mover.
 *
 * `unanswered` is the mover not answering at all, which is not the bucket's
 * fault: the walk tries the page again shortly rather than failing the
 * workspace (and with it the rollout). `failed` carries the walk's own code.
 */
export async function runWalkPageOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  walk: { runId: number; phase: WalkPagePhase; cursor?: string },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<WalkPageOutcome> {
  const body = await handToMover(
    ctx,
    workspaceId,
    { walkRunId: walk.runId, phase: walk.phase, expectedCursor: walk.cursor },
    origin,
    options,
  );
  if (body === null || typeof body !== "object") return { kind: "unanswered" };
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    if (answer.error === "STALE") return { kind: "stale" };
    return { kind: "failed", code: typeof answer.error === "string" && WALK_CODE.test(answer.error) ? answer.error : "WALK_FAILED" };
  }
  const done = answer.done;
  if (answer.phase !== walk.phase || typeof done !== "number" || !Number.isInteger(done) || done < 0) {
    return { kind: "failed", code: "WALK_FAILED" };
  }
  const nextCursor = typeof answer.nextCursor === "string" && answer.nextCursor !== "" ? answer.nextCursor : null;
  return { kind: "done", nextCursor, done };
}

/* -------------------------------------------------------------------------- */
/*                    a page of the path-to-id copy on the mover              */
/* -------------------------------------------------------------------------- */

export type NoteIdPageOutcome =
  | { kind: "done"; results: unknown[] }
  | { kind: "stale" }
  | { kind: "unanswered" }
  | { kind: "failed"; code: string };

/**
 * Hand one page of the id copy (`id_copy`) or its check (`id_check`) to the
 * mover. The ticket names the run and the items; the mover answers what it did
 * to those items, and the caller reads the answer for them only.
 */
export async function runNoteIdPageOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  page: { runId: number; phase: "id_copy" | "id_check"; items: NoteIdItem[] },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<NoteIdPageOutcome> {
  const body = await handToMover(
    ctx,
    workspaceId,
    { idRunId: page.runId, idItems: page.items, phase: page.phase },
    origin,
    options,
  );
  if (body === null || typeof body !== "object") return { kind: "unanswered" };
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    if (answer.error === "STALE") return { kind: "stale" };
    return { kind: "failed", code: typeof answer.error === "string" && WALK_CODE.test(answer.error) ? answer.error : "ID_COPY_FAILED" };
  }
  return { kind: "done", results: Array.isArray(answer.results) ? answer.results : [] };
}

/* -------------------------------------------------------------------------- */
/*                 a page of the old-copy cleanup on the mover                */
/* -------------------------------------------------------------------------- */

export type CleanupOutcome<T> =
  | ({ kind: "done" } & T)
  | { kind: "stale" }
  | { kind: "unanswered" }
  | { kind: "failed"; code: string };

/** The answer a cleanup page gave, or the outcome that says why there is none. */
function cleanupAnswer(body: unknown): { ok: true; answer: Record<string, unknown> } | CleanupOutcome<never> {
  if (body === null || typeof body !== "object") return { kind: "unanswered" };
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    if (answer.error === "STALE") return { kind: "stale" };
    return { kind: "failed", code: typeof answer.error === "string" && WALK_CODE.test(answer.error) ? answer.error : "CLEANUP_FAILED" };
  }
  return { ok: true, answer };
}

/** One page of the bucket's keys, from `cursor`, listed by the mover. Keys only; no body is read. */
export async function runCleanupListOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  page: { runId: number; cursor?: string },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<CleanupOutcome<{ keys: string[]; nextCursor: string | null }>> {
  const body = await handToMover(
    ctx,
    workspaceId,
    { cleanupRunId: page.runId, phase: "cleanup_list", ...(page.cursor === undefined ? {} : { expectedCursor: page.cursor }) },
    origin,
    options,
  );
  const answered = cleanupAnswer(body);
  if (!("ok" in answered)) return answered;
  const keys = Array.isArray(answered.answer.keys) ? answered.answer.keys.filter((key): key is string => typeof key === "string") : [];
  const nextCursor = typeof answered.answer.nextCursor === "string" && answered.answer.nextCursor !== "" ? answered.answer.nextCursor : null;
  return { kind: "done", keys, nextCursor };
}

/** The keys one delete page may remove, deleted by the mover; one answer per key. */
export async function runCleanupDeleteOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  page: { runId: number; keys: string[] },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<CleanupOutcome<{ results: { key: string; ok: boolean; reason?: string }[] }>> {
  const body = await handToMover(ctx, workspaceId, { cleanupRunId: page.runId, cleanupKeys: page.keys, phase: "cleanup_delete" }, origin, options);
  const answered = cleanupAnswer(body);
  if (!("ok" in answered)) return answered;
  const results = Array.isArray(answered.answer.results)
    ? answered.answer.results.filter(
        (entry): entry is { key: string; ok: boolean; reason?: string } =>
          entry !== null && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string" && typeof (entry as { ok?: unknown }).ok === "boolean",
      )
    : [];
  return { kind: "done", results };
}
