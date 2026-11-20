import assert from "node:assert/strict";
import { createEgressWorld, textTex, TOKEN_TEXTS, S3_ENDPOINT } from "../../agentEgressFixtures.mjs";

export default {
  id: "yes-unread-asks-answered",
  incident: "2026-11-20: in a Lab test chat, Tex asked whether to start a note, the person texted a 👍, the Door failed three times and Tex said nothing.",
  cause: "A yes or 👍 lists the asks waiting for a yes from the workspace's bucket, a test chat never reaches that bucket, and the failed listing was not caught, so the turn died before the Front door.",
  path: "1:1 text",
  async run() {
    const world = await createEgressWorld();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      return url.startsWith(S3_ENDPOINT) ? new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", { status: 403 }) : inner(input, init);
    };
    try {
      world.model.install([{ text: "Want me to start a note for the trip? 👍 or 👎?" }, { text: "Started it." }]);
      await textTex(world.env, TOKEN_TEXTS, "put the ferry times with my trip notes");
      const answered = await textTex(world.env, TOKEN_TEXTS, "👍");
      assert.equal(answered.status, 200, "the 👍 is answered, not a failed turn");
      assert.equal(answered.body?.answer, "Started it.", "by the Front door, which read it like any text");
    } finally {
      globalThis.fetch = inner;
      world.restore?.();
    }
  },
};
