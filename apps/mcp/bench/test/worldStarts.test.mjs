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
