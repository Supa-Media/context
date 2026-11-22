import assert from "node:assert/strict";
import { chatEnv } from "../../../../../packages/tex/gateway/texChat.js";

const APP = "app:k7m2q9x4b8n3c6v1";

export default {
  id: "app-job-report-reaches-app",
  incident: "2026-11-20: the in-app Tex review found a background job started from the app chat never reported back there (gap 21).",
  cause: "A job reports to its chat by name through the Worker's objects, and an app chat has no Worker object: the report landed in an empty one.",
  path: "1:1 text (app), job report",
  // Sabotage (2026-11-20): `appChatNameOf` answering null sends the report over the Worker's RPC, and this fails.
  async run() {
    const reached = [];
    const overRpc = [];
    const env = await chatEnv(
      {
        PUBLIC_ORIGIN: "https://gateway.example",
        TEX_CHAT: { idFromName: (name) => name, get: (name) => ({ fetch: async (request) => (reached.push([name, new URL(request.url).pathname]), Response.json({ outcome: "taken" })) }) },
        TEXTING: { inboxFetch: async (id) => (overRpc.push(id.name), Response.json({})) },
      },
      { waitUntil() {}, storage: { get: async () => undefined, put: async () => {}, delete: async () => true } },
      "job:j1",
      "",
      { gateway: () => ({ fetch: async () => new Response(null) }), texts: () => ({ fetch: async () => new Response(null) }) },
    );
    const answer = await env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(`enam:${APP}`)).fetch("https://inbox/job-update", { method: "POST", body: JSON.stringify({ id: "j1", state: "done" }) });
    assert.equal(answer.status, 200);
    assert.deepEqual(reached, [[`chat:${APP}`, "/chat-call/job-update"]], "the report reaches the app chat's own object");
    assert.deepEqual(overRpc, [], "never the Worker's empty object");
  },
};
