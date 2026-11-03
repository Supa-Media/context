/**
 * THE TEX PAGE'S CLIENT CALLS (`src/controlPlane/texPage.js`, the control plane's `functions/texPage.ts`).
 *
 * The gateway forwards the console's own token and passes on only known answers: a page the control plane did not
 * send in one of its two shapes, or a settings answer outside its list, is null, never shown as if it were real.
 *
 * Sabotage (run by hand): forward a body's `userId` or pass any status through (drop the known-status check):
 * "only known answers pass" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/controlPlane/index.js";

function plane(answer) {
  const posted = [];
  const fetchImpl = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  };
  const cp = createControlPlane({ CONTROL_PLANE_URL: "https://control.example.test", GATEWAY_SECRET: "gw-secret-not-real" }, { fetchImpl });
  return { cp, posted };
}

test("the page is asked with the console's token, and only its two answers pass", async () => {
  const { cp, posted } = plane({ status: "refused" });
  assert.deepEqual(await cp.texPage("cat_console"), { status: "refused" });
  assert.match(posted[0].url, /\/gateway\/tex\/page$/);
  assert.deepEqual(posted[0].body, { accessToken: "cat_console" });

  const unknown = plane({ status: "pwned" });
  assert.equal(await unknown.cp.texPage("cat_console"), null);
});

test("a settings change names the chat and its values, and only known answers pass", async () => {
  const { cp, posted } = plane({ status: "done", instructions: "Be candid.", engagement: "attentive" });
  assert.deepEqual(await cp.texPageSettings("cat_console", "ab".repeat(32), { pick: "candid", answers: "named" }), {
    status: "done",
    instructions: "Be candid.",
    engagement: "attentive",
  });
  assert.match(posted[0].url, /\/gateway\/tex\/page\/settings$/);
  assert.deepEqual(posted[0].body, { accessToken: "cat_console", chat: "ab".repeat(32), values: { pick: "candid", answers: "named" } });

  const unknown = plane({ status: "ok" });
  assert.equal(await unknown.cp.texPageSettings("cat_console", "me", { pick: "candid" }), null);
});
