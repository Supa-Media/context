/**
 * A YES THAT CANNOT READ WHAT WAITS FOR IT STILL GETS AN ANSWER (2026-11-20).
 *
 * The asks waiting for a person's yes live in the workspace's bucket (`tools/approvals.js`). A Lab test chat never
 * reaches that bucket, so every bare "yes" or 👍 there failed the door three times and Tex said nothing; a real chat
 * whose bucket is down would do the same. Now the door's yes step (`texEntryPoint/settleAYesOrNo.js`) settles nothing
 * when it cannot read them, and the text goes on to the Front door like any other.
 *
 * Sabotage (temporary local edit, reverted, 2026-11-20): the try/catch in `settleAYesOrNo.js` removed fails
 * "a 👍 text whose asks cannot be read is answered" (the turn answers 500).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createEgressWorld, textTex, TOKEN_TEXTS, S3_ENDPOINT } from "./agentEgressFixtures.mjs";

/** The world with its bucket refusing every request, as a test chat's keyless binding does. */
async function bucketDownWorld() {
  const world = await createEgressWorld();
  const inner = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.startsWith(S3_ENDPOINT)) {
      refused += 1;
      return new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", { status: 403 });
    }
    return inner(input, init);
  };
  return { ...world, refused: () => refused, restore: () => ((globalThis.fetch = inner), world.restore?.()) };
}

for (const yes of ["👍", "yes"]) {
  test(`a ${yes} text whose asks cannot be read is answered`, async () => {
    const world = await bucketDownWorld();
    try {
      world.model.install([{ text: "Should I start that note? 👍 or 👎?" }, { text: "Started it." }]);
      await textTex(world.env, TOKEN_TEXTS, "add to my judges note");
      const answered = await textTex(world.env, TOKEN_TEXTS, yes);
      assert.ok(world.refused() > 0, "the bucket was asked and refused");
      assert.equal(answered.status, 200);
      assert.equal(answered.body?.answer, "Started it.");
    } finally {
      world.restore();
    }
  });
}
