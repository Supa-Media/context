/**
 * The gateway's client for `POST /gateway/note-ids/resolve`
 * (`controlPlane/noteIds.js`, `noteIdResolve`).
 *
 * What is proved:
 *  - the request carries the same proofs as lookup (the workspace, the
 *    person's token, and the expected workspace), with the note ids as sent;
 *  - every id asked for is answered, a path where the control plane gave one
 *    and `null` otherwise, and repeats are asked once;
 *  - an empty or oversized (201) id list is refused before anything is asked;
 *  - a reply with no `paths` map, or a refusal, is a `ControlPlaneError`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlPlane } from "../src/controlPlane/index.js";
import { ControlPlaneError } from "../src/controlPlane/client.js";

function recorder(answer, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const ENV = { CONTROL_PLANE_URL: "https://cp.example/", GATEWAY_SECRET: "secret" };
const PLAN_ID = "0190c0de-0000-7000-8000-00000000a001";
const GONE_ID = "0190c0de-0000-7000-8000-00000000a006";

test("noteIdResolve posts the ids with the same proofs as lookup, and answers every id asked for", async () => {
  const { calls, fetchImpl } = recorder({ paths: { [PLAN_ID]: "1-projects/plan.md", [GONE_ID]: null } });
  const cp = createControlPlane(ENV, { fetchImpl });
  const answer = await cp.noteIdResolve("tok", "w1", [PLAN_ID, GONE_ID, PLAN_ID]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cp.example/gateway/note-ids/resolve");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(calls[0].body, {
    workspaceId: "w1",
    noteIds: [PLAN_ID, GONE_ID, PLAN_ID],
    accessToken: "tok",
    expectedWorkspaceId: "w1",
  });
  assert.deepEqual(answer, { paths: { [PLAN_ID]: "1-projects/plan.md", [GONE_ID]: null } });
});

test("noteIdResolve answers null for an id the reply left out or answered with something that is not a path", async () => {
  const { fetchImpl } = recorder({ paths: { [PLAN_ID]: 42 } });
  const cp = createControlPlane(ENV, { fetchImpl });
  const answer = await cp.noteIdResolve("tok", "w1", [PLAN_ID, GONE_ID]);
  assert.deepEqual(answer, { paths: { [PLAN_ID]: null, [GONE_ID]: null } });
});

test("noteIdResolve refuses an empty or oversized id list before asking", async () => {
  const { calls, fetchImpl } = recorder({ paths: {} });
  const cp = createControlPlane(ENV, { fetchImpl });
  await assert.rejects(cp.noteIdResolve("tok", "w1", []), ControlPlaneError);
  await assert.rejects(
    cp.noteIdResolve("tok", "w1", Array.from({ length: 201 }, (_, i) => `0190c0de-0000-7000-8000-${String(i).padStart(12, "0")}`)),
    ControlPlaneError,
  );
  assert.equal(calls.length, 0);
});

test("noteIdResolve refuses a reply with no paths map, and any refusal from the control plane", async () => {
  const missing = createControlPlane(ENV, { fetchImpl: recorder({}).fetchImpl });
  await assert.rejects(missing.noteIdResolve("tok", "w1", [PLAN_ID]), ControlPlaneError);
  const refused = createControlPlane(ENV, { fetchImpl: recorder({ error: "invalid_request" }, 400).fetchImpl });
  await assert.rejects(refused.noteIdResolve("tok", "w1", [PLAN_ID]), ControlPlaneError);
});
