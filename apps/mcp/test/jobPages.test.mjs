/**
 * A JOB STARTS WITH THE PAGES ITS CHAT ALREADY OPENED (`src/agent/jobPages.js`;
 * Dev2, 2026-11-12). The Nov Babies job guessed five web addresses, one a
 * parked domain, though the chat had opened the real ones minutes earlier.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `pagesSection(opened())` dropped from `backgroundSession`'s start: "a started
 *    job's brief ends with the pages the chat opened" fails;
 *  - `jobOf` cutting the brief at the model's 2,000: "the kept brief holds them" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundSession, jobOf, startedJobs } from "../src/agent/background.js";
import { MAX_JOB_PAGES, chatPages, pagesSection } from "../src/agent/jobPages.js";
import { pagesOpenedBefore } from "../src/agent/turnWeb.js";

const NOW = Date.UTC(2026, 10, 12, 2, 40);
const HISTORY = [
  { role: "user", text: "karaoke maybe? something fun for 20" },
  { role: "assistant", text: "POP is my pick.", sources: ["https://popkaraoke32.com/", "https://www.mskims.co/private-karaoke", "note:tex/groups/x/a.md"] },
  { role: "user", text: "and dinner as well" },
  { role: "assistant", text: "Katz's has a room for 50.", sources: ["https://www.theinfatuation.com/new-york/guides/where-to-have-a-private-dinner-in-nyc-right-now", "https://popkaraoke32.com/"] },
];

test("a started job's brief ends with the pages the chat opened, written by code, each once", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW, opened: () => pagesOpenedBefore(HISTORY) });
  await background.call({ title: "Birthday for 20", brief: "Verify POP, Ms. Kim's and Katz's." });
  const { jobs: [job] } = startedJobs(background, false);
  assert.match(job.brief, /^Verify POP, Ms\. Kim's and Katz's\.\n\nPages this chat already opened \(open a place's site by its exact address here; never guess a web address\):\n/);
  for (const page of ["https://popkaraoke32.com/", "https://www.mskims.co/private-karaoke", "https://www.theinfatuation.com/new-york/guides/where-to-have-a-private-dinner-in-nyc-right-now"]) {
    assert.equal(job.brief.split(`- ${page}\n`).length + job.brief.endsWith(`- ${page}`) - 1, 1, `${page} once`);
  }
  assert.doesNotMatch(job.brief, /note:/, "web pages only");
  const none = backgroundSession({ running: [], job: null, now: NOW });
  await none.call({ title: "Plan Lisbon", brief: "Flights for May" });
  assert.equal(startedJobs(none, false).jobs[0].brief, "Flights for May", "no pages, nothing added");
});

test("the kept brief holds them: the model's 2,000 characters and the pages after", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://example${i}.com/${"p".repeat(120)}`);
  const background = backgroundSession({ running: [], job: null, now: NOW, opened: () => many });
  await background.call({ title: "Long one", brief: "w".repeat(2_500) });
  const { brief } = startedJobs(background, false).jobs[0];
  assert.ok(brief.startsWith("w".repeat(2_000) + "\n\nPages"), "the model's words are cut at 2,000 as before");
  assert.ok(brief.length <= 4_000);
  assert.match(brief, /example39\.com/, "the newest pages are the ones kept");
  assert.equal(jobOf({ id: "ed6f8a7c-05b8-4787-be30-8c874fcb4485", title: "Long one", brief }).brief, brief, "the job's own turn reads all of it");
});

test("only https addresses, newest kept, at most twenty", () => {
  assert.deepEqual(chatPages(["http://plain.example/", "https://a.example/", "javascript:alert(1)", "https://b.example/x y", "https://a.example/"]), ["https://a.example/"]);
  assert.equal(chatPages(Array.from({ length: 30 }, (_, i) => `https://s${i}.example/`)).length, MAX_JOB_PAGES);
  assert.equal(pagesSection([]), "");
});
