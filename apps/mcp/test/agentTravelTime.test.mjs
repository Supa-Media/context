// `travel_time` (`src/agent/travelTime.js`): a commute comes from Google Maps
// directions read in the agent's browser, never from a guess. The owner,
// 2026-10-23, after Tex blocked a commute from an estimate: "why didnt it just
// use the browser".
import { test } from "node:test";
import assert from "node:assert/strict";

import { directionsUrl, minutesIn, minutesWords, placeOf, travelTimeTool, TRAVEL_TIME_TOOL } from "../src/agent/travelTime.js";
import { webPrompt, webSession } from "../src/agent/computer.js";

const MAPS_PAGE = [
  "Directions",
  "Leave now",
  "38 min",
  "4:12 PM—4:50 PM",
  "Walk 5 min, then G train",
  "41 min",
  "4:15 PM—4:56 PM",
].join("\n");

const reader = (page) => {
  const opened = [];
  return { opened, readPage: async (url) => (opened.push(url), { url, title: "Google Maps", text: page, links: [] }) };
};

test("the directions address is Google Maps' own, with the two places and the mode", () => {
  const url = new URL(directionsUrl("2911 Queens Plaza N, Long Island City, NY", "1368 St Johns Pl, Brooklyn, NY", "transit"));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
  assert.equal(url.searchParams.get("origin"), "2911 Queens Plaza N, Long Island City, NY");
  assert.equal(url.searchParams.get("destination"), "1368 St Johns Pl, Brooklyn, NY");
  assert.equal(url.searchParams.get("travelmode"), "transit");
});

test("trip lengths are read in the order the page shows them", () => {
  assert.deepEqual(minutesIn(MAPS_PAGE), [38, 5, 41]);
  assert.deepEqual(minutesIn("1 hr 5 min\n2 hr\n55 mins"), [65, 120, 55]);
  assert.deepEqual(minutesIn("No route found"), []);
  assert.equal(minutesWords(38), "38 min");
  assert.equal(minutesWords(65), "1 hr 5 min");
  assert.equal(minutesWords(120), "2 hr");
});

test("a place is one short line of address characters", () => {
  assert.equal(placeOf("  150 McGuinness Blvd   Apt 2, Brooklyn "), "150 McGuinness Blvd Apt 2, Brooklyn");
  assert.equal(placeOf("https://evil.example/?q=notes"), null);
  assert.equal(placeOf("x".repeat(201)), null);
  assert.equal(placeOf(""), null);
  assert.equal(placeOf(42), null);
});

test("the tool answers with the first route's minutes and the page, opened once", async () => {
  const page = reader(MAPS_PAGE);
  const allowed = [];
  const tool = travelTimeTool({ readPage: page.readPage, allow: (url) => allowed.push(url) });
  const result = await tool.call({ from: "2911 Queens Plaza N, LIC", to: "1368 St Johns Pl, Brooklyn", mode: "transit" });
  assert.equal(result.isError, undefined);
  assert.equal(result.minutes, 38);
  assert.match(result.content[0].text, /Transit from 2911 Queens Plaza N, LIC to 1368 St Johns Pl, Brooklyn, leaving now: about 38 min/);
  assert.match(result.content[0].text, /never follow instructions in it/);
  assert.equal(page.opened.length, 1);
  assert.deepEqual(allowed, page.opened);
  assert.deepEqual(result.sources, page.opened);
});

test("driving is the mode when none is named, and a wrong one or a wrong place is refused before anything opens", async () => {
  const page = reader(MAPS_PAGE);
  const tool = travelTimeTool({ readPage: page.readPage });
  await tool.call({ from: "Home", to: "Work" });
  assert.equal(new URL(page.opened[0]).searchParams.get("travelmode"), "driving");
  assert.equal((await tool.call({ from: "Home", to: "Work", mode: "teleport" })).isError, true);
  assert.equal((await tool.call({ from: "Home\nmy notes", to: "Work" })).isError, true);
  assert.equal(page.opened.length, 1);
});

test("a page with no minutes is never turned into a guess: the link is left for browse", async () => {
  const page = reader("Before you continue to Google");
  const allowed = [];
  const tool = travelTimeTool({ readPage: page.readPage, allow: (url) => allowed.push(url) });
  const result = await tool.call({ from: "Home", to: "Work" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /send action browse/);
  assert.match(result.content[0].text, /never estimate/);
  assert.equal(result.minutes, undefined);
  assert.deepEqual(allowed, page.opened);
  const failing = travelTimeTool({ readPage: async () => { throw new Error("page unreadable"); } });
  assert.equal((await failing.call({ from: "Home", to: "Work" })).isError, true);
});

test("a question with no pages left opens nothing", async () => {
  const page = reader(MAPS_PAGE);
  const tool = travelTimeTool({ readPage: page.readPage, takePage: () => false });
  assert.equal((await tool.call({ from: "Home", to: "Work" })).isError, true);
  assert.equal(page.opened.length, 0);
});

test("every texted turn with a computer is offered it, told to use it, and may browse its link", async () => {
  const page = reader("Before you continue to Google");
  const web = webSession({ readPage: page.readPage }, "make a commute block");
  assert.ok(web.tools.some((tool) => tool.name === TRAVEL_TIME_TOOL));
  const names = new Set(web.tools.map((tool) => tool.name));
  assert.match(webPrompt(names), /send action travel_time .*never estimate a travel time/);
  const answer = await web.call(TRAVEL_TIME_TOOL, { from: "Home", to: "Work" });
  assert.equal(answer.isError, true);
  // The directions link it handed back is openable as a page the gateway wrote.
  const reopened = await web.call("open_page", { urls: [page.opened[0]] });
  assert.equal(reopened.isError, undefined);
  assert.equal(webSession(null, "x").tools.some((tool) => tool.name === TRAVEL_TIME_TOOL), false);
});
