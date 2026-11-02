/**
 * Whether each homed group chat's grant can open its home (2026-11-02). No home holds its chat's history page yet,
 * though two homed chats were answered since turns began moving history there (`texFolderNames.ts` `pages`), and a
 * turn whose home does not open keeps history in the record with nothing logged (`apps/mcp/src/agent/chatHome.js`).
 * The gateway opens a home only when the grant's setup row names it (`liveGrants.ts` `groupSetupRow`) and the grant's
 * own scopes include write (`apps/mcp/src/session.js` `sessionForChatHome`); this says which of those each chat's
 * newest grant has.
 *
 * Read only, and it answers fixed codes and counts, never an id, a path, a name or a key: it is run from the
 * `Tex folder names` workflow, whose log is public.
 */

import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { v } from "convex/values";
import { chatHomeOf } from "./lib/textGroupHome";
import { contextsForGrant, validateLiveGrantRecord } from "./lib/controlPlane/liveGrants";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";

/** When turns began moving a home's history onto its page (`texFolderNames.ts`). */
const ON_PAGE_SINCE = Date.parse("2026-11-01T14:30:00Z");

function count(into: Record<string, number>, code: string) {
  into[code] = (into[code] ?? 0) + 1;
}

export const homeGrants = internalQuery({
  args: {},
  returns: v.object({ homes: v.number(), chats: v.record(v.string(), v.number()) }),
  handler: async (ctx) => {
    const pin = await pinnedContextWorkspace(ctx);
    const chats: Record<string, number> = {};
    let homes = 0;
    for (const chat of await ctx.db.query("textGroups").collect()) {
      if ((await chatHomeOf(ctx, chat._id)) === null) continue;
      homes += 1;
      const own: string[] = [chat.lastSeenAt >= ON_PAGE_SINCE ? "seen_since_page_move" : "not_seen_since_page_move"];
      const places = [chat.workspaceId, pin?._id].filter((id): id is NonNullable<typeof id> => id !== undefined);
      let newest: Doc<"oauthGrants"> | null = null;
      for (const workspaceId of new Set(places)) {
        const rows = await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "active"))
          .collect();
        for (const grant of rows) {
          if (grant.clientId !== TEXTS_GROUP_CLIENT_ID || grant.texGroup?.groupId !== chat._id) continue;
          if (newest === null || grant._creationTime > newest._creationTime) newest = grant;
        }
      }
      if (newest === null) {
        own.push("no_active_grant");
      } else {
        own.push(newest.texGroup?.homeOnly === true ? "home_only" : "bound");
        own.push(newest.scopes.includes("context:write") ? "grant_writes" : "grant_reads_only");
        // Its token may have run out since the last turn; every other check is judged as a new turn's would be.
        if (typeof newest.accessTokenExpiresAt !== "number" || newest.accessTokenExpiresAt <= Date.now()) own.push("token_expired");
        const live = await validateLiveGrantRecord(ctx, { ...newest, accessTokenExpiresAt: Date.now() + 60_000 });
        if (live === null) {
          own.push("not_live");
        } else {
          const rows = await contextsForGrant(ctx, live);
          const setup = rows.find((row) => row.setupOnly === true || row.homeOnly === true);
          own.push(setup === undefined ? "no_setup_row" : typeof setup.chatHome === "string" ? "setup_names_home" : "setup_without_home");
          if (setup !== undefined) own.push(`setup_role_${setup.role}`);
        }
      }
      count(chats, own.join("+"));
    }
    return { homes, chats };
  },
});
