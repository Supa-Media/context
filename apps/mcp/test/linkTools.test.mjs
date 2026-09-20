/**
 * THE THREE LINK TOOLS — an agent asking for a link and getting a URL.
 *
 * The console has had share links since the beginning and nothing in this
 * surface could mint one, so an agent asked for "a link to send them" had two
 * options and took the wrong one: it wrote a URL out of the path it was
 * holding. A guessed URL is worse than no URL — it looks right, it gets
 * pasted, and it opens nothing.
 *
 * What is proved here is the boundary rather than the happy path:
 *
 *  1. **The gateway builds nothing.** What comes back is what the control
 *     plane returned, and the *token never appears in it*. An agent that could
 *     see a token could assemble an address, which is the thing being removed.
 *  2. **Minting is the owner's**, at the listing and at the call, and the
 *     refusal is one sentence for every cause.
 *  3. **A short name that cannot be claimed does not lose the link.** The row
 *     is real and usable at its long URL either way.
 *  4. **Revoke is uniform**: not yours, already gone and never existed are one
 *     answer, and an id from another context is not an oracle.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER_TOKEN = `cat_links_owner_${"0".repeat(16)}`;
const READONLY_TOKEN = `cat_links_readonly_${"0".repeat(13)}`;
const MEMBER_TOKEN = `cat_links_member_${"0".repeat(15)}`;
const OTHER_TOKEN = `cat_links_other_${"0".repeat(16)}`;
/** Writes, and reads at team tier — the grant the tier gate is actually about. */
const TEAM_TIER_TOKEN = `cat_links_team_${"0".repeat(17)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const NOTE = "1-projects/plan.md";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

async function rpc(env, token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body;
}

async function call(env, token, name, args = {}) {
  const body = await rpc(env, token, "tools/call", { name, arguments: args });
  return {
    text: body?.result?.content?.[0]?.text ?? "",
    isError: body?.result?.isError === true,
  };
}

/** The share id out of what `create_link` or `list_links` printed. */
function idIn(text) {
  return /^id: (\S+)$/m.exec(text)?.[1] ?? null;
}

export async function runLinkToolChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const otherBucket = createBucket();

    const binding = (bindingName) => ({
      provider: "r2-binding",
      bindingName,
      capabilities: { conditionalWrite: true, conditionalCreate: true },
      status: "active",
    });
    controlPlane.addWorkspace("ws_links", "seyi", binding("LINKS_BUCKET"));
    controlPlane.addWorkspace("ws_other", "other", binding("OTHER_BUCKET"));

    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_links_owner",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: READONLY_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:private"],
      clientId: "mcp_client_links_readonly",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: MEMBER_TOKEN,
      workspaceId: "ws_links",
      role: "member",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_links_member",
      userId: "user_dan",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TIER_TOKEN,
      workspaceId: "ws_links",
      role: "owner",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_links_team_tier",
      userId: "user_seyi",
    });
    await controlPlane.addGrant({
      accessToken: OTHER_TOKEN,
      workspaceId: "ws_other",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_links_other",
      userId: "user_out",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "LINKS_BUCKET,OTHER_BUCKET",
      LINKS_BUCKET: bucket,
      OTHER_BUCKET: otherBucket,
    };
    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# Context\n");
    bucket.seed(NOTE, "# Plan\n");
    otherBucket.seed("privacy.md", MANIFEST);

    /* ------------------------- the URL, not the token ---------------------- */

    const minted = await call(env, OWNER_TOKEN, "create_link", { path: NOTE });
    check("an owner can mint a link", !minted.isError);
    check("...and is handed the URL rather than a token", /link: https:\/\/\S+\/s\/\S+/.test(minted.text));
    check(
      "...and is told what it opens and who it is for",
      minted.text.includes(`opens: ${NOTE}`) &&
        minted.text.includes("anyone with the link, no account needed"),
    );
    check(
      "...and that anyone holding it needs no account",
      /without an account/.test(minted.text),
    );

    const shareId = idIn(minted.text);
    check("...and an id it can revoke with later", typeof shareId === "string" && shareId !== "");

    /* --------------------------- the short name ---------------------------- */

    const named = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/intake.md",
      short: "Intake",
    });
    check("a short name is claimed, lowercased", named.text.includes("/@seyi/intake"));
    check(
      "...and the agent is told a short name is guessable, which the long one is not",
      /guessable by anyone who types it/.test(named.text),
    );

    const clash = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/other.md",
      short: "intake",
    });
    check("a name already taken does not lose the link", !clash.isError);
    check("...the link is still there", /link: https:\/\//.test(clash.text));
    check("...and the reason the name was refused is reported", /already points at another link/.test(clash.text));
    check("...with no short link claimed", !clash.text.includes("short link:"));

    const reserved = await call(env, OWNER_TOKEN, "create_link", {
      path: "1-projects/reserved.md",
      short: "1-projects",
    });
    check("a name Context writes into every workspace is refused", /reserved for Context/.test(reserved.text));

    /* ----------------------------- who may mint ---------------------------- */

    const memberList = await rpc(env, MEMBER_TOKEN, "tools/list");
    check(
      "a member is not shown the link tools at all",
      !memberList.result.tools.some((tool) => tool.name === "create_link"),
    );
    const memberMint = await call(env, MEMBER_TOKEN, "create_link", { path: NOTE });
    check("...and a member that calls one anyway is refused", memberMint.isError);

    /*
      THE TIER GATE, WHICH IS A DIFFERENT GATE FROM THE ROLE ONE.

      A member is filtered out by write scope and would be whatever this set
      said. This grant writes — it is shown `write_note` — and reads at team
      tier, which is exactly what `PRIVATE_TIER_ONLY_TOOLS` decides. Without
      that entry it would be offered three tools the control plane refuses
      every time, and an agent would spend a turn finding that out.
    */
    const teamTierList = await rpc(env, TEAM_TIER_TOKEN, "tools/list");
    check(
      "a team-tier grant is shown the write tools",
      teamTierList.result.tools.some((tool) => tool.name === "write_note"),
    );
    check(
      "...and not the link tools, which are the owner's private-tier ones",
      !teamTierList.result.tools.some((tool) =>
        ["create_link", "list_links", "revoke_link"].includes(tool.name),
      ),
    );
    const teamTierMint = await call(env, TEAM_TIER_TOKEN, "create_link", { path: NOTE });
    check("...and calling one anyway is refused", teamTierMint.isError);

    const readOnlyMint = await call(env, READONLY_TOKEN, "create_link", { path: NOTE });
    check("a read-only grant cannot mint, whatever its role", readOnlyMint.isError);
    check(
      "...and the refusal names no reason it could not have known",
      !readOnlyMint.text.includes(NOTE),
    );

    /* ------------------------------- listing ------------------------------- */

    const listed = await call(env, OWNER_TOKEN, "list_links");
    check("the owner's listing names what it published", listed.text.includes(`opens: ${NOTE}`));
    check("...and every row carries a URL", (listed.text.match(/link: https:\/\//g) ?? []).length >= 2);
    check(
      "...and no row carries a token to assemble one from",
      !/token/i.test(listed.text),
    );

    const otherList = await call(env, OTHER_TOKEN, "list_links");
    check(
      "another context's owner sees nothing of this one",
      !otherList.text.includes(NOTE),
    );

    /* ------------------------------- revoking ------------------------------ */

    const foreign = await call(env, OTHER_TOKEN, "revoke_link", { share_id: shareId });
    check("an id from another context cannot be revoked", foreign.isError);
    const invented = await call(env, OTHER_TOKEN, "revoke_link", { share_id: "share_nope" });
    check(
      "...and answers exactly as an invented id does",
      foreign.text === invented.text,
    );

    const revoked = await call(env, OWNER_TOKEN, "revoke_link", { share_id: shareId });
    check("the owner can revoke", !revoked.isError);
    check(
      "...and is told the card that already unfurled cannot be recalled",
      /cannot be recalled/.test(revoked.text),
    );
    const again = await call(env, OWNER_TOKEN, "revoke_link", { share_id: shareId });
    check("revoking twice refuses like an id that never existed", again.isError);

    const afterRevoke = await call(env, OWNER_TOKEN, "list_links");
    check("...and the link is out of the listing", !afterRevoke.text.includes(`opens: ${NOTE}\n`));
  } finally {
    restore?.();
  }
}
