/**
 * Handing one page of a whole-bucket move to the gateway's mover, so the
 * files go bucket to bucket inside Cloudflare and never through this
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
 * Run the migration's current page on the mover. `null` when the page was
 * already taken over (the row moved on before the mover opened it), which is
 * the same no-op a stale page is here. Throws one of the action's codes
 * otherwise.
 */
export async function runMigrationPageOnMover(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  migration: Doc<"managedStorageMigrations">,
  origin: string,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<MigrationPageResult | null> {
  if (migration.phase === "count") throw new Error("COPY_FAILED");
  const secret = (options.env ?? process.env)[GATEWAY_SECRET_ENV_VAR];
  if (!secret) throw new Error("COPY_FAILED");
  const ticket = randomOpaqueToken();
  const hashedTicket = await hashToken(ticket);
  await ctx.runMutation(internal.functions.storageMover.mintPage, {
    hashedTicket,
    workspaceId,
    migrationId: migration._id,
    phase: migration.phase,
    ...(migration.cursor === undefined ? {} : { expectedCursor: migration.cursor }),
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
      // Unreachable or too slow: retried like any page that failed.
      throw new Error("COPY_FAILED");
    }
    if (response.status !== 200) throw new Error("COPY_FAILED");
    const result = readResult(await response.json().catch(() => null));
    return result === "stale" ? null : result;
  } finally {
    clearTimeout(timer);
    // Spent tickets are already gone; this drops one the mover never opened.
    await ctx.runMutation(internal.functions.storageMover.dropPage, { hashedTicket }).catch(() => undefined);
  }
}
