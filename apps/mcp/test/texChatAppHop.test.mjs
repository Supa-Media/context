/**
 * AN APP CHAT'S TURN GOES OVER A HOP, AS A PHONE'S DOES.
 *
 * Dev2's 8:25 AM app text (2026-11-20): the app chat's `TexChat` object ran the whole turn in-process and its isolate ran
 * out of memory before the reply went. Dev2 chose the phone's route: the turn (`POST <gateway>/agent`) leaves the
 * object over the network, and only the gateway's smaller routes stay in-process.
 *
 * Sabotage checked: making `isTurnCall` always false fails "the turn goes over the hop"; dropping the `app &&` guard
 * fails "a phone chat's turn stays in-process"; calling `inProcess()` without the kept clone fails "a hop that throws".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatEnv, hopToGateway, isTurnCall } from "../../../packages/tex/gateway/texChat.js";

const SELF = "https://gateway.example";
const APP = "app:abcdefghijklmnop1234";
const state = { waitUntil() {}, storage: { get: async () => undefined, put: async () => {}, delete: async () => true } };

async function envFor(name, hop) {
  const local = [];
  const env = await chatEnv({ PUBLIC_ORIGIN: SELF }, state, name, "", {
    gateway: () => ({ fetch: async (request) => (local.push(new URL(request.url).pathname), Response.json({ local: true })) }),
    texts: () => ({ fetch: async () => new Response(null) }),
    hop,
  });
  return { env, local };
}

describe("an app chat's turn", () => {
  it("the turn goes over the hop, with its body and headers", async () => {
    const hopped = [];
    const { env, local } = await envFor(APP, async (request) => (hopped.push([request.url, request.headers.get("authorization"), await request.text()]), Response.json({ hop: true })));
    const answer = await env.FETCH(`${SELF}/agent`, { method: "POST", headers: { authorization: "Bearer t" }, body: '{"question":"hi"}' });
    assert.deepEqual(await answer.json(), { hop: true });
    assert.deepEqual(hopped, [[`${SELF}/agent`, "Bearer t", '{"question":"hi"}']]);
    assert.deepEqual(local, []);
  });

  it("the gateway's smaller routes stay in-process", async () => {
    const hopped = [];
    const { env, local } = await envFor(APP, async (request) => (hopped.push(request.url), new Response(null)));
    await env.FETCH(`${SELF}/agent/steer`, { method: "POST", body: "{}" });
    await env.FETCH(`${SELF}/agent/events`, { method: "POST", body: "{}" });
    assert.deepEqual(hopped, []);
    assert.deepEqual(local, ["/agent/steer", "/agent/events"]);
  });

  it("a phone chat's turn stays in-process", async () => {
    const hopped = [];
    const { env, local } = await envFor("+15555550100", async (request) => (hopped.push(request.url), new Response(null)));
    await env.FETCH(`${SELF}/agent`, { method: "POST", body: "{}" });
    assert.deepEqual(hopped, []);
    assert.deepEqual(local, ["/agent"]);
  });

  it("a hop that throws runs the turn in-process, with the body still whole", async () => {
    let body = null;
    const answer = await hopToGateway(
      async (request) => (await request.text(), Promise.reject(new TypeError("no route"))),
      new Request(`${SELF}/agent`, { method: "POST", body: '{"question":"hi"}' }),
      async (kept) => ((body = await kept.text()), Response.json({ local: true })),
    );
    assert.deepEqual(await answer.json(), { local: true });
    assert.equal(body, '{"question":"hi"}');
  });

  it("an answer from the hop, an error status included, is passed on as it is", async () => {
    let ran = false;
    const answer = await hopToGateway(async () => new Response("no", { status: 502 }), new Request(`${SELF}/agent`, { method: "POST", body: "{}" }), async () => ((ran = true), new Response(null)));
    assert.equal(answer.status, 502);
    assert.equal(ran, false);
  });

  it("only the turn's own address counts as the turn", () => {
    assert.equal(isTurnCall(`${SELF}/agent`, SELF), true);
    assert.equal(isTurnCall(`${SELF}/agent?x=1`, SELF), true);
    assert.equal(isTurnCall(`${SELF}/agent/steer`, SELF), false);
    assert.equal(isTurnCall(`${SELF}/agents`, SELF), false);
    assert.equal(isTurnCall(`https://other.example/agent`, SELF), false);
  });
});
