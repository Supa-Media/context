/**
 * A step's reads run in change-tier order (`packages/tex/src/texModuleChange.cjs`, Dev2 2026-11-20): a module that
 * changes less never sits below one that changes more, whatever order the config lists them in, so the prompt cache
 * reads it. The Lab shows each move (`runMoves`).
 *
 * Sabotage: `runOrder` returning the list as given fails "a per-text module listed first runs last" and the router check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changeOf, runMoves, runOrder } from "../../../packages/tex/src/texModuleChange.cjs";
import { routerContextText } from "../src/agent/routerContext.js";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

test("each kind of read has the tier it changes at", () => {
  assert.equal(changeOf("p-rules"), "fixed");
  assert.equal(changeOf("train:fd:all:66000"), "fixed");
  assert.equal(changeOf("about"), "summary");
  assert.equal(changeOf("summaries:all:30000"), "summary");
  assert.equal(changeOf("chat:7:130000"), "grows");
  assert.equal(changeOf("date"), "text");
  assert.equal(changeOf("out:job"), "text");
  assert.equal(changeOf("something-new"), "text", "an unknown module is put last, where it costs nothing new");
  assert.equal(changeOf("about", { about: { changes: "text" } }), "text", "a draft may set a module's tier");
  assert.equal(changeOf("about", { about: { changes: "sometimes" } }), "summary", "an unknown tier falls back to the default");
});

test("a per-text module listed first runs last, and the listed order holds within a tier", () => {
  const ctx = ["date", "chat:7:130000", "about", "p-rules", "ask", "p-tools"];
  assert.deepEqual(runOrder(ctx), ["p-rules", "p-tools", "about", "chat:7:130000", "date", "ask"]);
  assert.deepEqual(ctx, ["date", "chat:7:130000", "about", "p-rules", "ask", "p-tools"], "the config's list is never changed");
  assert.deepEqual(runMoves(ctx).find((move) => move.key === "date"), { key: "date", listed: 1, runs: 5, changes: "text" });
  assert.deepEqual(runMoves(["p-rules", "about", "chat:1:1000", "date"]), [], "a list already in run order has no moves");
});

test("the front door's own reads: about-me runs above the chat, as the gateway sends it", () => {
  const fd = TEX_CONFIG.nodes.find((node) => node.id === "fd");
  const ran = runOrder(fd.ctx);
  assert.ok(ran.indexOf("about") < ran.findIndex((key) => key.startsWith("chat:")), "about-me above the chat word for word");
  assert.ok(ran.findIndex((key) => key.startsWith("chat:")) < ran.indexOf("date"), "the chat above the time");
});

test("the router's reads are sent in run order: the group brief above the last texts and the time", () => {
  const text = routerContextText(["recent", "date", "groupBrief"], { history: "Ana: hi", facts: ["Tex is drafting the menu"], today: "Thursday" }, 5_000);
  assert.ok(text.indexOf("<now>") < text.indexOf("<chat-history>"), "the brief before the chat");
  assert.ok(text.indexOf("<chat-history>") < text.indexOf("<today>"), "the chat before the time");
});
