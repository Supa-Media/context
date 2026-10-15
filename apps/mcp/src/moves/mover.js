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
 * ## What it runs
 *
 * Two kinds of page, named by the spent ticket (never by the caller):
 *
 * - a whole-bucket move's page (`migrationPage.js`): counts, the next cursor,
 *   and the keys of files left behind over the file limit, which the control
 *   plane already shows the owner;
 * - a page of the managed-storage encryption walk (`walkPage.js`): the phase,
 *   the next cursor and how many objects it sealed or opened;
 * - a batch of a move from one workspace into another (`contextMovePage.js`),
 *   the one page that holds two workspaces' keys (owner, 2026-10-14): what
 *   landed, what stayed behind and why, and edits that raced the move;
 * - a batch of the move from path keys to id keys inside one bucket
 *   (`idCopyPage.js`): `idCopy` copies each path to its id key, and `idCheck`
 *   reports, per path, whether the id key already holds the same object.
 *
 * Failures answer a code only; a provider's text never leaves, since it can
 * name a key.
 */

import { createControlPlane } from "../controlPlane.js";
import { sha256Hex } from "../controlPlane/client.js";
import { timingSafeEqual } from "../crypto/bytes.js";
import { json } from "../http/responses.js";
import { StorageUnavailable, storeForBinding } from "../store/factory.js";
import { runContextMovePage } from "./contextMovePage.js";
import { runIdCheckPage, runIdCopyPage } from "./idCopyPage.js";
import { runMigrationPage } from "./migrationPage.js";
import { WALK_PAGE_PHASES, runWalkPage } from "./walkPage.js";

export const MOVER_PAGE_PATH = "/internal/mover/page";

/** The failure codes the control plane already knows how to retry or end on. */
const PASSED_THROUGH = new Set(["OBJECT_TOO_LARGE", "VERIFY_FAILED"]);
const PHASES = new Set(["copy", "verify_source", "verify_target"]);
const WALK_PHASES = new Set(WALK_PAGE_PHASES);
/** A walk failure's own code (`ManagedEncryptionError`), when it is one. */
const WALK_CODE = /^[A-Z_]{3,40}$/;

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

/**
 * A walk page: one managed bucket, its data key, and where to start. The
 * bucket is the workspace's own, so it carries that workspace's id, and the
 * key is shaped as the cipher needs it or the page is refused.
 */
function readOpenedWalk(opened) {
  const { workspaceId, phase, source, dataKey, limits } = opened;
  if (typeof workspaceId !== "string" || workspaceId === "" || !WALK_PHASES.has(phase)) return null;
  if (!source || typeof source !== "object" || source.workspaceId !== workspaceId) return null;
  if (!dataKey || typeof dataKey !== "object" || typeof dataKey.current !== "string" ||
      !dataKey.keys || typeof dataKey.keys !== "object" || typeof dataKey.keys[dataKey.current] !== "string") return null;
  if (!limits || !positive(limits.pageSize) || !positive(limits.lanes) || !positive(limits.byteBudget)) return null;
  if (opened.cursor !== undefined && opened.cursor !== null && typeof opened.cursor !== "string") return null;
  return { ...opened, cursor: typeof opened.cursor === "string" ? opened.cursor : undefined };
}

/** Objects one batch may name, as many as the control plane plans (`CONTEXT_MOVE_BATCH_OBJECTS`). */
const CONTEXT_MOVE_OBJECTS = 40;

/**
 * A batch between two workspaces: two different workspaces' buckets, each
 * carrying its own id, and a list of keys to carry. Any other shape is
 * refused, never guessed at.
 */
function readOpenedContextMove(opened) {
  const { source, destination, objects, limits } = opened;
  const side = (value) => value && typeof value === "object" && typeof value.workspaceId === "string" && value.workspaceId !== "";
  if (!side(source) || !side(destination) || source.workspaceId === destination.workspaceId) return null;
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > CONTEXT_MOVE_OBJECTS) return null;
  for (const object of objects) {
    if (!object || typeof object.source !== "string" || object.source === "" ||
        typeof object.destination !== "string" || object.destination === "" ||
        typeof object.size !== "number" || !Number.isFinite(object.size) || object.size < 0) return null;
  }
  if (!limits || !positive(limits.lanes) || !positive(limits.byteBudget) || !positive(limits.maxObjectBytes)) return null;
  return opened;
}

async function runContextMove(opened, deps) {
  const page = readOpenedContextMove(opened);
  if (page === null) return json({ ok: false, error: "STORAGE_UNSAFE" });
  try {
    return json({ ok: true, ...(await runContextMovePage(page, deps)) });
  } catch (error) {
    const code = error instanceof StorageUnavailable ? "SOURCE_UNAVAILABLE" : "STORAGE_UNSAFE";
    console.error("mover.context_move_failed", {
      sourceWorkspaceId: page.source.workspaceId,
      destinationWorkspaceId: page.destination.workspaceId,
      code,
    });
    return json({ ok: false, error: code });
  }
}

function walkFailureCode(error) {
  if (error instanceof StorageUnavailable) return "SOURCE_UNAVAILABLE";
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && WALK_CODE.test(code) ? code : "WALK_FAILED";
}

async function runWalk(opened, deps) {
  const page = readOpenedWalk(opened);
  if (page === null) return json({ ok: false, error: "WALK_FAILED" });
  try {
    return json({ ok: true, ...(await runWalkPage(page, deps)) });
  } catch (error) {
    console.error("mover.walk_failed", { workspaceId: page.workspaceId, phase: page.phase, code: walkFailureCode(error) });
    return json({ ok: false, error: walkFailureCode(error) });
  }
}

/** Items one id-move page may name, as many as the control plane plans. */
const ID_ITEMS_MAX = 500;
/** A path-key move's destinations: a note body or an attachment, never anything else. */
const ID_KEY = /^(notes|files)\//;

/**
 * An id-move page: one bucket, its workspace's own, and a list of paths with
 * the id keys they go to. A key outside `notes/` or `files/` is refused, so a
 * page cannot write anywhere but the two places the id layout owns.
 */
function readOpenedIdPage(opened) {
  const { workspaceId, source, items, limits } = opened;
  if (typeof workspaceId !== "string" || workspaceId === "") return null;
  if (!source || typeof source !== "object" || source.workspaceId !== workspaceId) return null;
  if (!Array.isArray(items) || items.length > ID_ITEMS_MAX) return null;
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || item.path === "" ||
        typeof item.key !== "string" || !ID_KEY.test(item.key) || item.key.split("/").includes("..")) return null;
  }
  if (!limits || !positive(limits.lanes) || !positive(limits.byteBudget)) return null;
  return opened;
}

async function runIdPage(opened, deps) {
  const page = readOpenedIdPage(opened);
  if (page === null) return json({ ok: false, error: "ID_COPY_FAILED" });
  try {
    const run = page.kind === "idCopy" ? runIdCopyPage : runIdCheckPage;
    return json({ ok: true, ...(await run(page, deps)) });
  } catch {
    // The workspace and the kind only: never a path, never provider text.
    console.error("mover.id_page_failed", { workspaceId: page.workspaceId, kind: page.kind });
    return json({ ok: false, error: "ID_COPY_FAILED" });
  }
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
  if (opened && typeof opened === "object" && opened.kind === "walk") return await runWalk(opened, deps);
  if (opened && typeof opened === "object" && opened.kind === "contextMove") return await runContextMove(opened, deps);
  if (opened && typeof opened === "object" && (opened.kind === "idCopy" || opened.kind === "idCheck")) {
    return await runIdPage(opened, deps);
  }
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
