/**
 * The mover: one page of a whole-bucket move, run next to the buckets.
 *
 * Owner, 2026-10-14: "we should not be downloading items into Convex and
 * back." A move into managed storage, or out to the customer's own bucket,
 * read every file into a Convex action and wrote it out again. The control
 * plane still decides what moves and keeps the migration row, its pace and
 * its retries; this route does the copying, so the bytes go from one bucket
 * to the other through this Worker and never reach Convex.
 *
 * ## The door
 *
 * `POST /internal/mover/page`, called by the control plane only
 * (`apps/convex/functions/lib/storageMover.ts`), with two proofs:
 *
 * 1. `Authorization: Bearer <GATEWAY_SECRET>`, compared as digests so the
 *    comparison says nothing about the secret's length;
 * 2. a ticket the control plane minted for exactly one page of one
 *    workspace's move, a few minutes long and spent on first use.
 *
 * The body carries the ticket and nothing else. Which workspace, which
 * buckets, which page and which rules all come back from the control plane
 * when the ticket is spent (`/gateway/mover/open`), so nothing a caller sends
 * can point the mover at another bucket. The secret alone opens nothing.
 *
 * ## What leaves
 *
 * Counts, the next cursor, and the keys of files left behind over the file
 * limit, which the control plane already shows the owner. Failures answer one
 * fixed code; a provider's text never leaves, since it can name a key.
 */

import { createControlPlane } from "../controlPlane.js";
import { sha256Hex } from "../controlPlane/client.js";
import { timingSafeEqual } from "../crypto/bytes.js";
import { json } from "../http/responses.js";
import { StorageUnavailable, storeForBinding } from "../store/factory.js";
import { runMigrationPage } from "./migrationPage.js";

export const MOVER_PAGE_PATH = "/internal/mover/page";

/** The failure codes the control plane already knows how to retry or end on. */
const PASSED_THROUGH = new Set(["OBJECT_TOO_LARGE", "VERIFY_FAILED"]);
const PHASES = new Set(["copy", "verify_source", "verify_target"]);

async function carriesGatewaySecret(request, env) {
  const secret = typeof env?.GATEWAY_SECRET === "string" ? env.GATEWAY_SECRET : "";
  if (secret === "") return false;
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(await sha256Hex(match[1]), await sha256Hex(secret));
}

async function readTicket(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const ticket = body && typeof body === "object" && !Array.isArray(body) ? body.ticket : null;
  return typeof ticket === "string" && ticket.length > 0 && ticket.length <= 256 ? ticket : null;
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Check the spent ticket's answer before a store is built from it: a page the
 * control plane described in any other shape is refused, never guessed at.
 */
function readOpenedPage(opened) {
  if (!opened || typeof opened !== "object") return null;
  const { workspaceId, phase, source, target, limits } = opened;
  if (typeof workspaceId !== "string" || workspaceId === "" || !PHASES.has(phase)) return null;
  if (!source || typeof source !== "object" || source.workspaceId !== workspaceId) return null;
  if (!target || typeof target !== "object") return null;
  if (!limits || !positive(limits.pageSize) || !positive(limits.byteCap) ||
      !positive(limits.maxWidth) || !positive(limits.byteBudget)) return null;
  if (opened.cursor !== undefined && opened.cursor !== null && typeof opened.cursor !== "string") return null;
  const rules = opened.rules && typeof opened.rules === "object" ? opened.rules : {};
  return {
    ...opened,
    cursor: typeof opened.cursor === "string" ? opened.cursor : undefined,
    rules: {
      deleteUnmatchedTarget: rules.deleteUnmatchedTarget === true,
      deleteOnlyUnder: typeof rules.deleteOnlyUnder === "string" ? rules.deleteOnlyUnder : undefined,
      keepTargetConflicts: rules.keepTargetConflicts === true,
    },
  };
}

function failureCode(error) {
  if (error instanceof StorageUnavailable) return "SOURCE_UNAVAILABLE";
  const message = error instanceof Error ? error.message : "";
  return PASSED_THROUGH.has(message) ? message : "COPY_FAILED";
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{ controlPlane?: { openMoverPage(ticket: string): Promise<object|null> }, buildStore?: typeof storeForBinding }} [deps]
 */
export async function handleMoverPage(request, env, deps = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!(await carriesGatewaySecret(request, env))) return json({ error: "unauthorized" }, 401);
  const ticket = await readTicket(request);
  if (ticket === null) return json({ error: "bad_request" }, 400);

  let opened;
  try {
    opened = await (deps.controlPlane ?? createControlPlane(env)).openMoverPage(ticket);
  } catch {
    return json({ ok: false, error: "SOURCE_UNAVAILABLE" });
  }
  if (opened === null) return json({ ok: false, error: "STALE" });
  const page = readOpenedPage(opened);
  if (page === null) return json({ ok: false, error: "COPY_FAILED" });
  try {
    return json({ ok: true, ...(await runMigrationPage(page, deps)) });
  } catch (error) {
    // The workspace and a fixed code only: never a key, never provider text.
    console.error("mover.page_failed", { workspaceId: page.workspaceId, phase: page.phase, code: failureCode(error) });
    return json({ ok: false, error: failureCode(error) });
  }
}
