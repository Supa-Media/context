/**
 * Handing the browser to the person (`src/agent/browse.js`), after the
 * 2026-10-10 conversation where Tex said "a link is on its way" and none came:
 * a browser that cannot be handed over is never described as one that can,
 * and a handoff that made no link ends the reply with the gateway's own line
 * saying so, whatever the model wrote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL, NO_LINK_LINE } from "../src/agent/browse.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";
import { ownHandle, texViewerUrl } from "../src/http/texComputer.js";

function fakeComputer({ canHandOff, handoffUrl = null }) {
  return {
    canHandOff: () => canHandOff,
    mayResume: () => canHandOff,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps) {
      const url = steps.find((step) => step.do === "goto")?.url ?? "https://shop.example.com/login";
      return {
        session: "sess-handoff-0001",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url, title: "Sign in", text: "", truncated: false, elements: [{ ref: 1, kind: "input password", label: "Password" }] },
        ...(handoffUrl ? { handoffUrl } : {}),
      };
    },
    async closeBrowser() {},
  };
}

const description = (web) => web.tools.find((tool) => tool.name === BROWSE_TOOL).description;
const handoffSteps = { steps: [{ do: "goto", url: "https://shop.example.com/" }, { do: "handoff" }] };

test("a browser that can be handed over is described as one, and its link ends the reply", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, handoffUrl: "https://live.example.com/abc" }), "sign in on shop.example.com");
  assert.match(description(web), /a link to this browser is added to your reply/);
  await web.call(BROWSE_TOOL, handoffSteps);
  assert.match(web.browser.handoffLine(), /https:\/\/live\.example\.com\/abc/);
});

test("a browser that cannot be handed over never promises a link", () => {
  const web = webSession(fakeComputer({ canHandOff: false }), "sign in on shop.example.com");
  assert.doesNotMatch(description(web), /a link to this browser is added/);
  assert.match(description(web), /never promise them a link/);
});

test("a handoff that made no link ends the reply with the gateway's line saying so", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, handoffUrl: null }), "sign in on shop.example.com");
  assert.equal(web.browser.handoffLine(), null, "nothing to say before a handoff is asked for");
  const result = await web.call(BROWSE_TOOL, handoffSteps);
  assert.match(result.content[0].text, /could not be made/);
  assert.equal(web.browser.handoffLine(), NO_LINK_LINE);
});

test("browsing with no handoff adds no line", async () => {
  const web = webSession(fakeComputer({ canHandOff: true, handoffUrl: null }), "look at shop.example.com");
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://shop.example.com/" }] });
  assert.equal(web.browser.handoffLine(), null);
});

/* ------------- The person's own page, never Browserbase's link (2026-10-11) ------------- */

const BROWSERBASE_LINK = "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/SESSION-SECRET";

/** The screenshot Worker as Browserbase answers: an older one also sent its live-view link. */
function browserbaseBinding(requests) {
  return {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ path: new URL(url).pathname, body });
      const target = body.steps.find((step) => step.do === "goto")?.url ?? "https://chatgpt.com/auth/login";
      return Response.json({
        session: "bb-1",
        ran: body.steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: target, title: "Log in", text: "", truncated: false, elements: [{ ref: 1, kind: "input password", label: "Password" }] },
        liveUrl: BROWSERBASE_LINK,
        handoffUrl: BROWSERBASE_LINK,
      });
    },
  };
}

const personal = (slug, role = "owner") => ({ workspaceId: `ws_${slug}`, slug, role, kind: "personal", grantedNames: [] });
const SEYI = { workspaces: [{ workspaceId: "ws_team", slug: "team-x", role: "owner", kind: "shared" }, personal("bola", "editor"), personal("seyi")] };

test("the handoff text is short: their own /tex/<handle> page and the site, never the browser's link", async () => {
  resetBrowserbaseProbe();
  const requests = [];
  const viewer = texViewerUrl({ APP_ORIGIN: "https://context.lc" }, SEYI);
  const computer = siteShotsComputer({ SITE_SHOTS: browserbaseBinding(requests) }, { owner: "a".repeat(64), viewer });
  const web = webSession(computer, "connect chatgpt.com to my context");
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://chatgpt.com/" }, { do: "handoff" }] });
  assert.equal(
    web.browser.handoffLine(),
    "Open this to take over the browser on chatgpt.com, then text me when you're done: https://context.lc/tex/seyi",
  );
  assert.ok(!web.browser.handoffLine().includes("browserbase"));
  resetBrowserbaseProbe();
});

test("a link the screenshot Worker sends is never taken for one to text", async () => {
  resetBrowserbaseProbe();
  const computer = siteShotsComputer({ SITE_SHOTS: browserbaseBinding([]) }, { owner: "a".repeat(64), viewer: "https://context.lc/tex/seyi" });
  const web = webSession(computer, "look at chatgpt.com");
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://chatgpt.com/" }] });
  assert.equal(web.browser.handoffLine(), null, "no handoff was asked for, so nothing is appended");
  assert.equal(web.browser.handoffLink(), null);
  resetBrowserbaseProbe();
});

test("with no page of theirs to take over on, the browser is never offered to hand over", async () => {
  resetBrowserbaseProbe();
  const computer = siteShotsComputer({ SITE_SHOTS: browserbaseBinding([]) }, { owner: "a".repeat(64), viewer: null });
  assert.equal(computer.canHandOff(), false);
  const web = webSession(computer, "connect chatgpt.com to my context");
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://chatgpt.com/" }, { do: "handoff" }] });
  assert.equal(result.isError, true);
  assert.equal(web.browser.handoffLine(), null);
  resetBrowserbaseProbe();
});

test("the handle is the personal workspace the person owns, never one they are only a member of", () => {
  assert.equal(ownHandle(SEYI), "seyi");
  assert.equal(ownHandle({ workspaces: [personal("bola", "editor"), personal("kemi", "member")] }), null);
  assert.equal(ownHandle({ workspaces: [{ workspaceId: "ws_s", slug: "shared-one", role: "owner", kind: "shared" }] }), null);
  assert.equal(texViewerUrl({ APP_ORIGIN: "https://staging.context.lc/" }, SEYI), "https://staging.context.lc/tex/seyi");
  assert.equal(texViewerUrl({}, SEYI), null, "a self-hosted gateway with no app origin texts no link");
  assert.equal(texViewerUrl({ APP_ORIGIN: "http://context.lc" }, SEYI), null);
  assert.equal(texViewerUrl({ APP_ORIGIN: "https://context.lc/app" }, SEYI), null);
});
