/**
 * `POST /gateway/workspaces/*`: setting a workspace up through an agent — a
 * new shared workspace, its starting layout or one built-in folder, and the
 * page where the person connects Google (decided by Dev2, 2026-10-17;
 * `docs/decisions/gateway-protocol/workspace-setup.md`).
 *
 * The two proofs every gateway route spends: the gateway secret (checked by
 * `gatewayRoute`) and the person's own access token, resolved here to a live
 * grant. The workspace a call acts on is one that grant reaches, never one the
 * gateway names alone, and the person is the grant's. Every route needs the
 * grant's `context:write`: a connection somebody made read-only sets nothing
 * up. What each one needs beyond that is the role the app asks for the same
 * thing, and the handler it calls asks again.
 *
 * Always 200. `{ <key>: null }` is the one answer for a token, a workspace or
 * a scope that does not clear; `{ <key>: { ok: false, message } }` is a
 * refusal to tell the person, given only after the caller cleared.
 */

import { ConvexError } from "convex/values";
import { integrationsSettingsPath } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { calendarConnectEnabled } from "../../calendarConnect";
import { mailConnectEnabled } from "../googleConnect/config";
import { hashToken } from "../crypto";
import { httpsAppOrigin, json, stringField } from "../gatewayAuth";
import { isLayoutName, layoutStructure } from "../workspaces/layouts";
import { clearanceOf } from "../clearance";
import { toConvexError } from "../filesFns/operationErrors";
import { giveJob, jobFolderPath } from "../../builtInFolders";

const SCOPE_WRITE = "context:write";
const SCOPE_PRIVATE = "context:private";

/** The longest display name the route forwards; the handler applies the real rule. */
const MAX_NAME_FIELD = 200;

type Covered = {
  workspaceId: string;
  slug: string;
  role: string;
  kind: "personal" | "shared";
  grantedNames?: string[];
};

/**
 * The grant behind `accessToken`, the workspace `expected` names in its reach,
 * and the person — or `null` for any token, workspace or scope that does not
 * clear. One predicate for the three routes, so none of them is laxer.
 */
async function clear(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<{ entry: Covered; actorUserId: Id<"users">; clientId: string; readsPrivate: boolean } | null> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  if (accessToken === null || expected === null) return null;
  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  if (session === null) return null;
  const entry = session.workspaces.find((workspace) => workspace.workspaceId === expected);
  if (entry === undefined) return null;
  const scopes = new Set(session.scopes);
  if (!scopes.has(SCOPE_WRITE)) return null;
  return {
    entry,
    actorUserId: session.actorUserId,
    clientId: session.clientId,
    // The grant's tier, clamped by the role, as the gateway reads it.
    readsPrivate: entry.role === "owner" && scopes.has(SCOPE_PRIVATE),
  };
}

/** A refusal written for a person, or a rethrow for anything that is not one. */
function refusal(error: unknown): { ok: false; message: string } {
  if (error instanceof ConvexError) {
    const message = (error.data as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message !== "") return { ok: false, message };
  }
  throw error;
}

/**
 * `/gateway/workspaces/create` — a shared workspace owned by the person, or,
 * with `dryRun`, whether the name is free. Any member of any workspace the
 * grant reaches may ask: the person can make a workspace in the app whatever
 * their role elsewhere, and the new one is theirs alone.
 */
export async function gatewayWorkspacesCreateHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const slug = stringField(body, "slug");
  const name = stringField(body, "name");
  if (slug === null) return json({ workspace: null });
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ workspace: null });

  if (body.dryRun === true) {
    const answer = await ctx.runQuery(internal.functions.gatewayWorkspaces.checkName, { name: slug });
    return json({ workspace: { ok: true, dryRun: true, ...answer } });
  }
  if (name === null || name.length > MAX_NAME_FIELD) {
    return json({ workspace: { ok: false, message: "Give the workspace a name to show, as well as its handle." } });
  }
  try {
    const created = await ctx.runMutation(internal.functions.gatewayWorkspaces.createShared, {
      actorUserId: cleared.actorUserId,
      actorClientId: cleared.clientId,
      slug,
      displayName: name,
    });
    return json({ workspace: { ok: true, slug: created.slug, storage: created.storage } });
  } catch (error) {
    return json({ workspace: refusal(error) });
  }
}

/**
 * `/gateway/workspaces/layout` — a starting layout (`template`, owner-only as
 * `applyStructure` is) or one built-in folder (`role`, owner or editor as the
 * app's "Add a folder" is). Exactly one of the two.
 */
export async function gatewayWorkspacesLayoutHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  if (body.job !== undefined) return await giveJobHandler(ctx, body);
  const template = body.template;
  const role = stringField(body, "role");
  if ((template === undefined) === (role === null)) return json({ layout: null });
  if (template !== undefined && !isLayoutName(template)) return json({ layout: null });
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ layout: null });
  const { entry } = cleared;
  const workspaceId = entry.workspaceId as Id<"workspaces">;

  if (role !== null) {
    if (entry.role !== "owner" && entry.role !== "editor") {
      return json({ layout: { ok: false, message: "Adding a folder needs an owner or an editor of this workspace." } });
    }
    try {
      const result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: cleared.readsPrivate ? "private" : "team",
        grantedNames: entry.grantedNames ?? [],
        operation: { kind: "addBuiltInFolder", role },
      });
      if (result.kind !== "folderCreated") return json({ layout: null });
      return json({ layout: { ok: true, folders: [result.path] } });
    } catch (error) {
      return json({ layout: refusal(error) });
    }
  }

  if (entry.role !== "owner") {
    return json({ layout: { ok: false, message: "Only an owner of this workspace can choose its layout." } });
  }
  try {
    const applied = await ctx.runMutation(internal.functions.gatewayWorkspaces.applyLayout, {
      actorUserId: cleared.actorUserId,
      workspaceId,
      ...layoutStructure(template as Parameters<typeof layoutStructure>[0]),
    });
    return json({ layout: { ok: true, queued: applied.queued, folders: applied.folders } });
  } catch (error) {
    return json({ layout: refusal(error) });
  }
}

/**
 * `/gateway/workspaces/layout` with `job`: give a built-in folder's job to the
 * folder at `path`, or take an optional one away (`path` null). Owner only,
 * as Settings › Built-in folders is (`builtInFolders.setJob`), at the grant's
 * own tier: a folder the connection cannot see is not found.
 */
async function giveJobHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const job = stringField(body, "job");
  const path = body.path === null ? null : stringField(body, "path");
  if (job === null || (path === null && body.path !== null)) return json({ layout: null });
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ layout: null });
  const { entry } = cleared;
  if (entry.role !== "owner") {
    return json({ layout: { ok: false, message: "Only an owner of this workspace can choose which folder does a job." } });
  }
  try {
    const clearance = clearanceOf(cleared.readsPrivate ? "private" : "team", entry.grantedNames ?? []);
    await giveJob(ctx, entry.workspaceId as Id<"workspaces">, clearance, job, jobFolderPath(path));
    return json({ layout: { ok: true, job, folders: path === null ? [] : [path] } });
  } catch (error) {
    return json({ layout: refusal(toConvexError(error)) });
  }
}

/**
 * `/gateway/workspaces/connect-google` — the page where the person connects
 * Gmail or Calendar themselves.
 *
 * A page, not Google's authorize URL. The connect is bound to the browser that
 * starts it: `startGoogleConnect` hands that browser a completion secret that
 * never travels through Google, and the callback refuses without it
 * (`docs/decisions/identity-and-access/grants-and-reach.md`, "A third-party
 * OAuth callback carries a secret the browser kept"). An authorize URL minted
 * here would be one nobody's browser holds the secret for, so it could never
 * complete — and handing the secret to an agent instead would undo the very
 * binding that stops a connect built by one person being finished by another.
 * The person opens Connected apps signed in, presses Connect, and signs in to
 * Google; that third party's sign-in is the one step that needs a browser.
 *
 * Owner of a personal workspace only, as `startGmailConnect` requires.
 */
export async function gatewayWorkspacesConnectGoogleHandler(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const kind = body.kind === "gmail" || body.kind === "calendar" ? body.kind : null;
  if (kind === null) return json({ google: null });
  const cleared = await clear(ctx, body);
  if (cleared === null) return json({ google: null });
  const { entry } = cleared;
  if (entry.kind !== "personal" || entry.role !== "owner") {
    return json({
      google: { ok: false, message: "Google connects only to your own personal workspace, by its owner." },
    });
  }
  const enabled = kind === "gmail" ? mailConnectEnabled() : calendarConnectEnabled();
  if (!enabled) {
    return json({
      google: {
        ok: false,
        message: `Connecting ${kind === "gmail" ? "Gmail" : "Google Calendar"} is not switched on for this deployment.`,
      },
    });
  }
  const origin = httpsAppOrigin();
  if (origin === null) return json({ google: null });
  return json({ google: { ok: true, url: `${origin}${integrationsSettingsPath(entry.slug)}` } });
}
