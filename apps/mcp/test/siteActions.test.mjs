/**
 * `write_note` `site` — an agent checks a website's draft and publishes it.
 *
 * The control plane decides everything (who may, what the draft is, what is
 * released); its own suite proves that (`apps/convex/__tests__/controlPlane/
 * siteGateway.test.ts`). What is proved here is the gateway's half:
 *
 *  1. The call carries this connection's own token and context, and the
 *     draft the agent was given, and nothing the agent did not pass.
 *  2. A refusal is one sentence whatever its cause, and an argument that is
 *     wrong is refused before anything is sent.
 *  3. The answer is worded so an agent can act on it: the draft to publish,
 *     what changed, what stops Publish, the conflict, the live addresses.
 *  4. Nothing is written to the bucket.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const EDITOR_TOKEN = `cat_site_editor_${"0".repeat(16)}`;
const MEMBER_TOKEN = `cat_site_member_${"0".repeat(16)}`;
const DRAFT = "3fa9c2e01b7d4a65";
const NEWER = "9b1c0d2e3f4a5b6c";

const STATUS = {
  action: "status",
  enabled: true,
  handle: "studio",
  draft: DRAFT,
  publishedRevision: 4,
  publishedAt: Date.UTC(2026, 9, 3, 7, 30),
  addresses: ["https://context.lc/@studio", "https://studio.ctxlc.site"],
  pages: [
    { path: "website/index.md", address: "/", status: "live", audience: "public", role: null, changed: false, problems: [] },
    { path: "website/about.md", address: "/about", status: "live", audience: "public", role: null, changed: true, problems: [] },
    { path: "website/layout.html.md", address: null, status: "live", audience: "public", role: "frame", changed: true, problems: [] },
  ],
  removed: [{ path: "website/old.md", address: "/old" }],
};

function createBucket() {
  const objects = new Map();
  return {
    objects,
    seed(key, body) {
      objects.set(key, { body, etag: `e${objects.size + 1}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      return stored ? { etag: stored.etag, text: async () => stored.body } : null;
    },
    async put(key, value) {
      objects.set(key, { body: String(value), etag: `w${objects.size + 1}`, uploaded: new Date() });
      return { etag: `w${objects.size}` };
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
          .map((key) => ({ key, size: objects.get(key).body.length, uploaded: objects.get(key).uploaded, etag: objects.get(key).etag })),
        truncated: false,
      };
    },
  };
}

async function call(env, token, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_note", arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return { text: body?.result?.content?.[0]?.text ?? JSON.stringify(body), isError: body?.result?.isError === true };
}

async function rawCall(env, token, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_note", arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body?.result?.content ?? [];
}

export async function runSiteActionChecks(check) {
  const bucket = createBucket();
  bucket.seed(
    "privacy.md",
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
      "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
      "folder_defaults:\n  index.md: team\n  website: team\n```\n\n" +
      "<!-- END BRAIN PRIVACY RULES -->\n",
  );
  bucket.seed("website/index.md", "# Home\n");
  let answer = STATUS;
  const controlPlane = createControlPlaneStub({ site: async () => answer });
  const restore = controlPlane.install();
  try {
    controlPlane.addWorkspace("ws_site", "studio", {
      provider: "r2-binding",
      bindingName: "SITE_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: EDITOR_TOKEN,
      workspaceId: "ws_site",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_site_editor",
      userId: "user_editor",
    });
    await controlPlane.addGrant({
      accessToken: MEMBER_TOKEN,
      workspaceId: "ws_site",
      role: "member",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_site_member",
      userId: "user_member",
    });
    const shots = [];
    let shotAnswer = null;
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "SITE_BUCKET",
      SITE_BUCKET: bucket,
      SITE_SHOTS: {
        async fetch(url, init) {
          shots.push({ url, body: JSON.parse(init.body) });
          return new Response(JSON.stringify(shotAnswer), { status: shotAnswer ? 200 : 503 });
        },
      },
    };
    const before = JSON.stringify([...bucket.objects.entries()]);
    const sent = () => controlPlane.siteCalls.at(-1);

    // -- status
    const status = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "status" } });
    check("an editor's status names the draft, the published revision and the addresses", !status.isError &&
      status.text.includes(`draft ${DRAFT}`) &&
      status.text.includes("published revision 4 (2026-10-03 07:30 UTC)") &&
      status.text.includes("https://studio.ctxlc.site"));
    check("...what changed and what publishing takes down",
      status.text.includes("website/about.md → /about") &&
      status.text.includes("website/layout.html.md") &&
      status.text.includes("publishing takes down (1): website/old.md → /old"));
    check("...and the exact call that publishes this draft",
      status.text.includes(`site: { action: "publish", draft: "${DRAFT}" }`));
    check("the call carried this connection's token, its own context and the action, and no draft it was not given",
      sent()?.accessToken === EDITOR_TOKEN && sent()?.expectedWorkspaceId === "ws_site" &&
      sent()?.action === "status" && !("draft" in sent()));

    answer = {
      ...STATUS,
      pages: [{ path: "website/broken.md", address: "/broken", status: "problem", audience: "public", role: null, changed: false, problems: ["audience must be public or members."] }],
      removed: [],
    };
    const broken = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "status" } });
    check("a page that stops Publish is listed with its reason, and no publish call is offered",
      broken.text.includes("- website/broken.md: audience must be public or members.") && !broken.text.includes('action: "publish"'));

    answer = { ...STATUS, enabled: false, draft: null, pages: [], removed: [], addresses: [] };
    const off = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "status" } });
    check("a site that is off says only the owner can turn it on", off.text.includes("the website is off"));

    // -- check
    answer = {
      action: "check",
      enabled: true,
      draft: DRAFT,
      routes: [
        { address: "/", path: "website/index.md", status: "live", audience: "public" },
        { address: "/contact", path: "website/contact.md", status: "draft", audience: "public" },
      ],
      pageProblems: [],
      links: [{ path: "website/layout.html.md", line: 4, target: "/abuot", problem: "no page has the address /abuot; did you mean /about?" }],
      pictures: [
        { name: "logo.png", bytes: 2048, usedBy: ["website/layout.html.md"], labels: [], problem: null },
        { name: "team.jpg", bytes: 4096, usedBy: ["website/about.md"], labels: ["original photograph"], problem: null },
        { name: "gone.png", bytes: null, usedBy: ["website/about.md"], problem: "no picture is stored under this exact name" },
      ],
      code: [{ path: "website/layout.html.md", role: "frame", removed: [{ line: 6, what: "<template> and everything inside it", why: "a <template> is never drawn, so nothing inside it shows" }] }],
      warnings: [{ path: "website/layout.html.md", why: "{ content } sits inside something the cleaner removes, so every page drawn with it shows nothing" }],
      more: { links: 0, removed: 0 },
      inspected: { path: "website/layout.html.md", output: "<header></header>", truncated: false },
    };
    const checked = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "check", inspect: "website/layout.html.md" } });
    check("a check names the draft and every address with its file", !checked.isError &&
      checked.text.includes(`website check · draft ${DRAFT}`) &&
      checked.text.includes("/ ← website/index.md; /contact ← website/contact.md (draft)"));
    check("...links that go nowhere by note and line, pictures by size and use",
      checked.text.includes("- website/layout.html.md:4 → /abuot: no page has the address /abuot; did you mean /about?") &&
      checked.text.includes("- logo.png (2 KB), used by website/layout.html.md\n") &&
      checked.text.includes('- team.jpg (4 KB), "original photograph", used by website/about.md') &&
      checked.text.includes("- gone.png, used by website/about.md: no picture is stored under this exact name"));
    check("...what the cleaner removed, by line, and what draws nothing",
      checked.text.includes("- website/layout.html.md:6 <template> and everything inside it: a <template> is never drawn") &&
      checked.text.includes("draws nothing, or less than it says (1):"));
    check("...and the inspected note as the site draws it, fenced",
      checked.text.includes("website/layout.html.md as the site draws it:\n```html\n<header></header>\n```"));
    check("the check carried the note to inspect as path", sent()?.action === "check" && sent()?.path === "website/layout.html.md");
    const badInspect = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "check", inspect: "privacy.md" } });
    const inspectOnStatus = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "status", inspect: "website/a.md" } });
    check("inspect names a note under website/, and only goes with check",
      badInspect.isError && inspectOnStatus.isError && sent()?.path === "website/layout.html.md");

    // -- screenshot
    const measured = (overrides = {}) => ({
      overflowX: 0, wide: [], bottomReachable: true, scrollHeight: 2400, viewportHeight: 844,
      clipped: [], brokenImages: [], headings: ["h1 Welcome"], textLength: 300, ...overrides,
    });
    answer = { action: "screenshot", url: "https://context.lc/@studio/about", address: "/about", revision: 5 };
    shotAnswer = {
      shots: [
        { size: "phone", width: 390, height: 2400, truncated: false, jpeg: "AAAA", measurements: measured({ overflowX: 42, wide: [{ element: "header.masthead", by: 42 }] }), errors: [] },
        { size: "desktop", width: 1280, height: 5000, truncated: true, jpeg: "BBBB", measurements: measured({ bottomReachable: false, clipped: [{ element: "div.hero", hidden: 300 }], brokenImages: ["Logo"] }), errors: ["TypeError: x"] },
      ],
      failures: [{ size: "tablet", reason: "Navigation timeout" }],
    };
    const photo = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot", page: "/about", sizes: ["phone", "tablet", "desktop"] } });
    const raw = await rawCall(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot", page: "/about" } });
    check("a screenshot asks the control plane for that page, then photographs only the address it built",
      sent()?.action === "screenshot" && sent()?.path === "/about" &&
      shots.length === 2 && shots[0].url === "https://site-shots/shoot" &&
      shots[0].body.url === "https://context.lc/@studio/about" &&
      JSON.stringify(shots[0].body.sizes) === JSON.stringify(["phone", "tablet", "desktop"]));
    check("...and reports each width's sideways scroll, bottom, hidden boxes, broken pictures and errors",
      !photo.isError &&
      photo.text.includes("published revision 5") &&
      photo.text.includes("sideways scroll: content is 42px wider than the screen (widest: header.masthead +42px)") &&
      photo.text.includes("the bottom of the page cannot be scrolled to") &&
      photo.text.includes("div.hero hides 300px") &&
      photo.text.includes("pictures that did not load: Logo") &&
      photo.text.includes("errors in the page: TypeError: x") &&
      photo.text.includes("tablet: failed: Navigation timeout"));
    check("...with each picture as an image the agent can look at",
      raw.filter((part) => part.type === "image").map((part) => part.data).join() === "AAAA,BBBB" &&
      raw.every((part) => part.type !== "image" || part.mimeType === "image/jpeg"));

    answer = { action: "screenshot", url: null, address: null, revision: null, message: "/members is for members only, and the browser that takes screenshots is not signed in, so it would only see the sign-in page." };
    const refusedShot = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot", page: "/members" } });
    check("a page the control plane will not hand over is refused with its reason, and no browser is opened",
      refusedShot.isError && refusedShot.text.includes("members only") && shots.length === 2);
    answer = { action: "screenshot", url: "https://context.lc/@studio", address: "/", revision: 5 };
    shotAnswer = null;
    const busy = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot" } });
    check("a browser that cannot answer is an error, never an empty success", busy.isError && busy.text.startsWith("no screenshot"));
    const badSize = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot", sizes: ["watch"] } });
    const badPage = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot", page: "https://evil.test/" } });
    const pageOnCheck = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "check", page: "/" } });
    check("an unknown size, a page that is not an address, and a page on another action are refused before anything is sent",
      badSize.isError && badPage.isError && pageOnCheck.isError && shots.length === 3);
    const unbound = await call({ ...env, SITE_SHOTS: undefined }, EDITOR_TOKEN, { path: "website/index.md", site: { action: "screenshot" } });
    check("a deployment with no browser says so", unbound.isError && unbound.text.includes("not available on this deployment"));

    // -- publish
    answer = { action: "publish", published: true, draft: DRAFT, revision: 5, addresses: STATUS.addresses, problems: [] };
    const published = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish", draft: DRAFT } });
    check("publish passes the checked draft through and answers with the revision and live addresses",
      !published.isError && sent()?.draft === DRAFT && sent()?.action === "publish" &&
      published.text.includes(`published draft ${DRAFT} as revision 5`) &&
      published.text.includes("live at: https://context.lc/@studio, https://studio.ctxlc.site"));

    answer = { action: "publish", published: false, conflict: true, draft: NEWER, revision: 4, addresses: [], problems: [] };
    const conflict = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish", draft: DRAFT } });
    check("a draft that is no longer the folder is a conflict that names the new draft and says to check again",
      conflict.isError && conflict.text.includes(`now draft ${NEWER}`) && conflict.text.includes("Check it again"));

    answer = { action: "publish", published: false, draft: DRAFT, revision: 4, addresses: [], problems: [{ path: "website/broken.md", message: "audience must be public or members." }] };
    const refusedPages = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish" } });
    check("a publish stopped by a page names it", refusedPages.isError && refusedPages.text.includes("- website/broken.md: audience must be public or members."));

    answer = { action: "publish", published: false, draft: null, revision: null, addresses: [], problems: [], message: "Turn the website on to publish it. Only the workspace's owner can, in the app." };
    const disabled = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish" } });
    check("a site that is off is refused with the control plane's reason", disabled.isError && disabled.text.includes("Turn the website on"));

    // -- refusals
    const callsBefore = controlPlane.siteCalls.length;
    const member = await call(env, MEMBER_TOKEN, { path: "website/index.md", site: { action: "publish" } });
    check("a member's connection is refused before anything is sent", member.isError && controlPlane.siteCalls.length === callsBefore);
    answer = null;
    const uncleared = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish" } });
    check("a refusal from the control plane is the one sentence, which names no cause",
      uncleared.isError && uncleared.text === "only this workspace's owners and editors can see a website's status or publish it, from a connection that can write.");
    const badDraft = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "publish", draft: "latest" } });
    const badAction = await call(env, EDITOR_TOKEN, { path: "website/index.md", site: { action: "unpublish" } });
    const withContent = await call(env, EDITOR_TOKEN, { path: "website/index.md", content: "# Hi\n", site: { action: "status" } });
    check("a malformed draft, an unknown action and a site passed with content are refused before anything is sent",
      badDraft.isError && badAction.isError && withContent.isError && controlPlane.siteCalls.length === callsBefore + 1);

    check("nothing was written to the bucket", JSON.stringify([...bucket.objects.entries()]) === before);
  } finally {
    restore();
  }
}
