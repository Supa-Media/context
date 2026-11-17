/**
 * A Tex store ticket is checked with Convex once, then remembered until its
 * own expiry (`src/texStore/ticketCache.js`). The door used to ask
 * `/gateway/tex-store/open` on every call: an HTTP action and a query, about
 * 14M of them in the month to 2026-11-17.
 *
 * Sabotage: drop `rememberedTicketShared` from `openTexStoreTicket` and the
 * first test asks twice. Remember a null open and the second test asks once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJobMethods } from "../src/controlPlane/jobs.js";
import { forgetTickets } from "../src/texStore/ticketCache.js";

function required(parsed, key) {
  if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, key)) throw new Error(`missing ${key}`);
  return parsed[key];
}

function jobsFor(answer) {
  let calls = 0;
  const jobs = createJobMethods({
    required,
    post: async () => {
      calls += 1;
      return { opened: answer() };
    },
  });
  return { jobs, calls: () => calls };
}

test("a ticket Convex opened is not asked again until it is forgotten", async () => {
  forgetTickets();
  const { jobs, calls } = jobsFor(() => ({ workspaceId: "ws", owners: ["person:ws"], expiresAt: Date.now() + 60_000 }));
  const first = await jobs.openTexStoreTicket("ticket-a");
  const second = await jobs.openTexStoreTicket("ticket-a");
  assert.equal(calls(), 1);
  assert.deepEqual(first, { workspaceId: "ws", owners: ["person:ws"] });
  assert.deepEqual(second, first);
  // A different ticket is its own proof.
  await jobs.openTexStoreTicket("ticket-b");
  assert.equal(calls(), 2);
  forgetTickets();
  await jobs.openTexStoreTicket("ticket-a");
  assert.equal(calls(), 3);
});

test("a miss is not remembered, and a ticket inside the margin is asked every time", async () => {
  forgetTickets();
  const missed = jobsFor(() => null);
  assert.equal(await missed.jobs.openTexStoreTicket("nope"), null);
  assert.equal(await missed.jobs.openTexStoreTicket("nope"), null);
  assert.equal(missed.calls(), 2);

  forgetTickets();
  const soon = jobsFor(() => ({ workspaceId: "ws", owners: ["person:ws"], expiresAt: Date.now() + 1_000 }));
  await soon.jobs.openTexStoreTicket("soon");
  await soon.jobs.openTexStoreTicket("soon");
  assert.equal(soon.calls(), 2);
});
