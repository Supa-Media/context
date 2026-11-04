/**
 * A PAGE GETS ITS OWN MINUTE (part B of the owner's decisions, 2026-11-01).
 *
 * Every page in one open_page call races its own `PAGE_OPEN_MS`, so a slow
 * page comes back as "could not be opened" while the others return, and the
 * failure is logged by its code alone. The tool's own limit covers a call's
 * pages and the one guessed after them, and the route names it.
 *
 * Sabotage (temporary local edits, reverted):
 *  - computer.js reading every page with no race: "one slow page" waits for it and reads it;
 *  - texEntryPoint toolTimeouts without open_page: "the route gives open_page its own limit" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { OPEN_PAGE_TIMEOUT_MS, OPEN_PAGE_TOOL, PAGE_OPEN_MS, webSession } from "../src/agent/computer.js";
import { texEntryPointSource } from "./texEntryPointSource.mjs";

const FAST = "https://fast.example.com/";
const SLOW = "https://slow.example.com/private-path";
const BROKEN = "https://broken.example.com/";

test("one slow page comes back as could not be opened while the others return, logged by its code only", async () => {
  const computer = {
    async readPage(url) {
      if (url === SLOW) return await new Promise((resolve) => setTimeout(() => resolve({ url, title: "Slow", text: "SLOW-PAGE-TEXT", truncated: false, links: [] }), 1_000));
      if (url === BROKEN) throw new Error("page unreadable at broken.example.com");
      return { url, title: "Fast", text: "FAST-PAGE-TEXT", truncated: false, links: [] };
    },
  };
  const web = webSession(computer, `${FAST} ${SLOW} ${BROKEN}`, { pageOpenMs: 20 });
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  let result;
  const began = Date.now();
  try {
    result = await web.call(OPEN_PAGE_TOOL, { urls: [FAST, SLOW, BROKEN] });
  } finally {
    console.log = log;
  }
  assert.ok(Date.now() - began < 500, "the call did not wait for the slow page");
  const said = result.content[0].text;
  assert.doesNotMatch(said, /SLOW-PAGE-TEXT/);
  assert.equal(result.isError, undefined);
  assert.match(said, /FAST-PAGE-TEXT/);
  assert.ok(said.includes(`${SLOW} could not be opened.`));
  assert.ok(said.includes(`${BROKEN} could not be opened.`));
  assert.deepEqual(result.sources, [FAST]);
  const codes = logged.map((line) => JSON.parse(line)).filter((line) => line.event === "open_page_failed").map((line) => line.code).sort();
  assert.deepEqual(codes, ["timeout", "unreadable"]);
  assert.ok(!logged.join("\n").includes("example.com"), "no address in the log");
});

test("the tool's limit covers a call's pages and the one guessed after them, and the route gives open_page its own limit", () => {
  assert.equal(PAGE_OPEN_MS, 60_000);
  assert.ok(OPEN_PAGE_TIMEOUT_MS >= 2 * PAGE_OPEN_MS);
  assert.match(texEntryPointSource(), /toolTimeouts: \{ open_page: OPEN_PAGE_TIMEOUT_MS,/);
});
