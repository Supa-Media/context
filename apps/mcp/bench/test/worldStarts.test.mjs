// The control plane starts a check-in, a routine and housekeeping in the person's zone; the bench must too. Sabotage:
// put back `timeZone: "UTC"` in `worldStarts.mjs` and a 9:30 pm Chicago reminder runs as 2:30 am (Dev set, 2026-11-17).
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkInTurn, routineTurn } from "../worldStarts.mjs";

const answered = (bodies) => async (body) => (bodies.push(body), { status: 200, body: { answer: "ok", outcome: "speak" }, ms: 1, usage: {} });

test("a check-in and a routine start in the zone they are given, UTC only when none is", async () => {
  const bodies = [];
  await checkInTurn(answered(bodies), () => [], "America/Chicago");
  await routineTurn("tex/routines/meds.md", answered(bodies), () => [], "America/Chicago");
  await routineTurn("tex/routines/meds.md", answered(bodies));
  assert.deepEqual(bodies.map((b) => (b.heartbeat ?? b.routine).timeZone), ["America/Chicago", "America/Chicago", "UTC"]);
});

// A quiet start says so in its own field, so the bench's record can tell a chosen silence from words.
test("startedTurn says quiet only when a successful start texted nothing", async () => {
  const { startedTurn } = await import("../worldStarts.mjs");
  const ok = { status: 200, body: { outcome: "quiet" }, ms: 1, usage: {} };
  assert.equal(startedTurn(ok, () => "").quiet, true);
  assert.equal(startedTurn({ status: 200, body: { outcome: "speak", answer: "hi" }, ms: 1, usage: {} }, () => "hi").quiet, false);
  assert.equal(startedTurn({ status: 500, body: null, ms: 1, usage: {} }, () => "").quiet, false);
});
