/**
 * Whether the control plane answers each homed group chat's home with a file list (2026-11-02). A turn's write to
 * its chat's history page in the home is refused "this workspace's file list could not be read just now"
 * (`apps/mcp/src/tree/served.js` `TreeUnavailable`): the home's session asks `/gateway/tree/manifest` for the pin
 * with the chat's grant, and anything but a served page is that refusal. This walks the same steps the route does
 * (`lib/nodes/gatewayManifest.ts`): the grant's contexts, the pin's clearance, and one manifest page of the home's
 * folder, and names the step that stops it.
 *
 * Read only, and it answers fixed codes and counts, never an id, a path, a name or a key: it is run from the
 * `Tex folder names` workflow, whose log is public.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { chatHomeOf } from "./lib/textGroupHome";
import { contextsForGrant, validateLiveGrantRecord } from "./lib/controlPlane/liveGrants";
import { gatewayManifestPage, gatewayReadClearance } from "./lib/nodes/gatewayManifest";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";

type Step = { codes: string[]; read?: { workspaceId: Id<"workspaces">; scope: "private" | "team"; names: string[]; folder: string } };

/** Each homed chat's newest grant, judged as a new turn's would be, up to the pin's clearance. */
export const clearances = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx): Promise<Step[]> => {
    const pin = await pinnedContextWorkspace(ctx);
    const out: Step[] = [];
    for (const chat of await ctx.db.query("textGroups").collect()) {
      const home = await chatHomeOf(ctx, chat._id);
      if (home === null) continue;
      if (pin === null) {
        out.push({ codes: ["no_pin"] });
        continue;
      }
      let newest: Doc<"oauthGrants"> | null = null;
      for (const workspaceId of new Set([chat.workspaceId, pin._id].filter((id): id is Id<"workspaces"> => id !== undefined))) {
        const rows = await ctx.db.query("oauthGrants").withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "active")).collect();
        for (const grant of rows) {
          if (grant.clientId !== TEXTS_GROUP_CLIENT_ID || grant.texGroup?.groupId !== chat._id) continue;
          if (newest === null || grant._creationTime > newest._creationTime) newest = grant;
        }
      }
      if (newest === null) {
        out.push({ codes: ["no_active_grant"] });
        continue;
      }
      const live = await validateLiveGrantRecord(ctx, { ...newest, accessTokenExpiresAt: Date.now() + 60_000 });
      if (live === null) {
        out.push({ codes: ["not_live"] });
        continue;
      }
      const rows = await contextsForGrant(ctx, live);
      const setup = rows.find((row) => row.workspaceId === pin._id);
      const codes = [setup === undefined ? "no_pin_row" : `pin_row_${setup.role}`, ...(setup?.grantedNames?.length ? ["pin_row_names"] : [])];
      const clearance = gatewayReadClearance({ scopes: live.grant.scopes, workspaces: rows }, pin._id);
      if (clearance === null) {
        out.push({ codes: [...codes, "no_clearance"] });
        continue;
      }
      codes.push(`clearance_${clearance.scope}_${clearance.audience}`);
      const folder = typeof setup?.chatHome === "string" ? setup.chatHome : "";
      if (folder === "") codes.push("no_home_folder");
      out.push({ codes, read: { workspaceId: clearance.workspaceId, scope: clearance.scope, names: clearance.names, folder } });
    }
    return out;
  },
});

export const manifests = internalAction({
  args: {},
  returns: v.object({ homes: v.number(), chats: v.record(v.string(), v.number()) }),
  handler: async (ctx) => {
    const steps: Step[] = await ctx.runQuery(internal.functions.texChatHomeManifest.clearances, {});
    const chats: Record<string, number> = {};
    for (const step of steps) {
      const codes = [...step.codes];
      if (step.read !== undefined) {
        for (const [label, folder] of [["home", step.read.folder], ["whole", undefined]] as const) {
          if (label === "home" && !folder) continue;
          try {
            const page = await gatewayManifestPage(ctx, step.read.workspaceId, step.read.scope, { names: step.read.names, ...(folder ? { folder } : {}) });
            codes.push(page.served ? `${label}_served_${page.entries.length > 0 ? "some" : "none"}` : `${label}_not_served`);
          } catch (error) {
            codes.push(`${label}_threw_${String((error as Error)?.name ?? "error").slice(0, 30)}`);
          }
        }
      }
      chats[codes.join("+")] = (chats[codes.join("+")] ?? 0) + 1;
    }
    return { homes: steps.length, chats };
  },
});
