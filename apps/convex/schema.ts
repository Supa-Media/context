import { defineSchema } from "convex/server";
import { supaAuthTables } from "@supa-media/convex/schema";
import { workspaceTables } from "./functions/lib/schema/workspaces";
import { obsidianPluginTables } from "./functions/lib/schema/obsidianPlugins";
import { membershipTables } from "./functions/lib/schema/membership";
import { shareTables } from "./functions/lib/schema/shares";
import { storageTables } from "./functions/lib/schema/storage";
import { credentialTables } from "./functions/lib/schema/credentials";
import { googleTables } from "./functions/lib/schema/google";
import { provisioningTables } from "./functions/lib/schema/provisioning";
import { ingestionTables } from "./functions/lib/schema/ingestion";
import { jobTables } from "./functions/lib/schema/jobs";
import { rateLimitTables } from "./functions/lib/schema/rateLimits";
import { oauthTables } from "./functions/lib/schema/oauth";
import { platformTables } from "./functions/lib/schema/platform";
import { billingTables } from "./functions/lib/schema/billing";

/**
 * Control-plane schema for Context.
 *
 * METADATA ONLY. Note content lives exclusively in the customer's own bucket
 * (see CLAUDE.md, "The customer owns the content, and can always leave with it"). Nothing in this file may
 * ever hold Markdown, note bodies, attachment bytes, or a second copy of
 * anyone's context. If a future table looks like it wants to cache note text,
 * that is the wrong table.
 *
 * ## Why not `supaTenantTables({ tenantName: "workspace" })`
 *
 * The framework's generic tenant tables give `workspaces` + `userWorkspaces`
 * with `slug: v.optional(v.string())`, `role: v.optional(v.string())`, and a
 * `workspaceId: v.string()` foreign key (the helper cannot emit `v.id()` for a
 * table name it only knows at runtime). Context needs the opposite of all
 * three: the slug is *required* and globally unique because it is how a
 * context is addressed (`@name/1-projects/foo.md`), the role is *required*
 * because write access is never implied, and the foreign keys must be real
 * `v.id()` references so a mis-scoped read is a type error rather than a
 * runtime surprise. Those are security properties, not cosmetics, so the
 * tables are declared explicitly here. `supaAuthTables` is still the framework
 * base — only the tenant half diverges. If the framework later grows a tenant
 * helper that can express required slugs and typed ids, this should move back
 * upstream.
 *
 * Each table is declared, with its reasoning, in the domain module under
 * `functions/lib/schema/` that owns it, and spread here in declaration order.
 */
const schema = defineSchema({
  ...supaAuthTables,
  ...workspaceTables,
  ...obsidianPluginTables,
  ...membershipTables,
  ...shareTables,
  ...storageTables,
  ...credentialTables,
  ...googleTables,
  ...provisioningTables,
  ...ingestionTables,
  ...jobTables,
  ...rateLimitTables,
  ...oauthTables,
  ...platformTables,
  ...billingTables,
});

export default schema;
