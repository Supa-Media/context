/**
 * Orient teaches an agent to build the website, where there is one to build:
 * the guide appears when the connection can see `website/`, and not in a
 * context with no site. See orientation.test.mjs for the module overview.
 */

import { orientText, createBucket, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./fixtures.mjs";
import { WEBSITE_GUIDE, websiteGuideFor } from "../../src/orient/websiteGuide.js";

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  website: team\n  1-projects: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export async function runOrientationWebsiteGuideChecks(check, harness) {
  const { controlPlane } = harness;
  const site = async (id, files) => {
    await controlPlane.addWorkspace(id, id.replace("ws_", ""), {
      provider: "r2-binding",
      bindingName: `${id.toUpperCase()}_BUCKET`,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    const token = `cat_orientation_${id}_owner_${"0".repeat(12)}`;
    await controlPlane.addGrant({
      accessToken: token,
      workspaceId: id,
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: `mcp_client_${id}`,
      userId: `user_${id}`,
    });
    const bucket = createBucket();
    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# Front page");
    for (const [key, text] of Object.entries(files)) bucket.seed(key, text);
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: `${id.toUpperCase()}_BUCKET`,
      [`${id.toUpperCase()}_BUCKET`]: bucket,
    };
    return await orientText(env, token);
  };

  const withSite = await site("ws_sitegd", { "website/index.md": "# Home\n" });
  check("orient carries the website guide where the context has a website folder", withSite.includes("## Building this context's website"));
  check("...naming the layout, stylesheet and loop syntax an agent writes", withSite.includes("layout.html.md") && withSite.includes(".css.md") && withSite.includes("{ each item in site.nav }"));

  check(
    "...and that site scripts only ever run sealed, which the agent says up front when asked for a site",
    withSite.includes("sealed") && withSite.includes("analytics") && withSite.includes("Tell the person"),
  );

  check(
    "...and the contract an agent otherwise learns by breaking a site: scoping, scrolling, addresses, Publish",
    withSite.includes("never write `.ctx-site`") &&
      withSite.includes("scrolls by itself") &&
      withSite.includes("not its file (`/index`)") &&
      withSite.includes("Saving is not publishing") &&
      withSite.includes('action: "publish", draft'),
  );

  const withoutSite = await site("ws_nositegd", { "1-projects/a.md": "# A\n" });
  check("...and not in a context with no website", !withoutSite.includes("## Building this context's website"));

  check(
    "the guide stays short enough to sit in every orient",
    WEBSITE_GUIDE.length < 3_000 && websiteGuideFor({ folders: [], rootNotes: [] }) === null,
  );
}
