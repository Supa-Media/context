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
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "./gatewayAuth";
import { MOVER_PAGE_TIMEOUT_MS } from "./managedProvisioningFns/constants";
import type { MigrationPageResult } from "./managedProvisioningFns/migrationRun";

type TicketPhase = Doc<"moverTickets">["phase"];
type CarriedObject = { source: string; destination: string; size: number };
type TicketFor =
  | { migrationId: Id<"managedStorageMigrations">; walkRunId?: undefined; contextMoveId?: undefined }
  | { walkRunId: number; migrationId?: undefined; contextMoveId?: undefined }
  | { contextMoveId: Id<"contextMoves">; objects: CarriedObject[]; migrationId?: undefined; walkRunId?: undefined };

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
    ...(page.contextMoveId === undefined ? {} : { contextMoveId: page.contextMoveId, objects: page.objects }),
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

export type ContextMoveBatchOutcome =
  | {
      kind: "done";
      landed: { source: string; destination: string; bytes: number }[];
      skipped: { path: string; reason: "encrypted" | "too_large" }[];
      conflicts: string[];
      failure: { destination: string; code: ContextMoveFailureCode } | null;
    }
  | { kind: "stale" }
  | { kind: "unanswered" }
  | { kind: "failed"; code: string };

/** What a batch may stop on (`CONTEXT_MOVE_FAILURES` in the gateway), and nothing else. */
export type ContextMoveFailureCode = "DESTINATION_EXISTS" | "NOTE_CAP_REACHED" | "STORAGE_UNSAFE" | "CONFLICT";
const CONTEXT_MOVE_FAILURE_CODES = new Set<string>(["DESTINATION_EXISTS", "NOTE_CAP_REACHED", "STORAGE_UNSAFE", "CONFLICT"]);

/**
 * Hand one batch of a move into another context to the mover. The ticket
 * names the move and the exact files (`objects`), which this deployment
 * planned; the mover's answer is read for those files only, so it cannot
 * report another key as moved.
 */
export async function runContextMoveBatchOnMover(
  ctx: ActionCtx,
  sourceWorkspaceId: Id<"workspaces">,
  batch: { moveId: Id<"contextMoves">; objects: CarriedObject[] },
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ContextMoveBatchOutcome> {
  const body = await handToMover(
    ctx,
    sourceWorkspaceId,
    { contextMoveId: batch.moveId, objects: batch.objects, phase: "carry" },
    origin,
    options,
  );
  if (body === null || typeof body !== "object") return { kind: "unanswered" };
  const answer = body as Record<string, unknown>;
  if (answer.ok !== true) {
    if (answer.error === "STALE") return { kind: "stale" };
    return { kind: "failed", code: typeof answer.error === "string" && WALK_CODE.test(answer.error) ? answer.error : "STORAGE_UNSAFE" };
  }
  const sources = new Map(batch.objects.map((object) => [object.source, object]));
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : [];
  const landed = list(answer.landed).flatMap((entry) => {
    const planned = typeof entry.source === "string" ? sources.get(entry.source) : undefined;
    if (planned === undefined || entry.destination !== planned.destination) return [];
    const bytes = typeof entry.bytes === "number" && Number.isFinite(entry.bytes) && entry.bytes >= 0 ? entry.bytes : 0;
    return [{ source: planned.source, destination: planned.destination, bytes }];
  });
  const skipped = list(answer.skipped).flatMap((entry) =>
    typeof entry.path === "string" && sources.has(entry.path) && (entry.reason === "encrypted" || entry.reason === "too_large")
      ? [{ path: entry.path, reason: entry.reason as "encrypted" | "too_large" }]
      : [],
  );
  const conflicts = Array.isArray(answer.conflicts)
    ? answer.conflicts.filter((path): path is string => typeof path === "string" && sources.has(path))
    : [];
  const raw = answer.failure as Record<string, unknown> | null | undefined;
  const failure = raw && typeof raw === "object"
    ? {
        destination: typeof raw.destination === "string" ? raw.destination : "",
        code: (typeof raw.code === "string" && CONTEXT_MOVE_FAILURE_CODES.has(raw.code) ? raw.code : "STORAGE_UNSAFE") as ContextMoveFailureCode,
      }
    : null;
  return { kind: "done", landed, skipped, conflicts, failure };
}
