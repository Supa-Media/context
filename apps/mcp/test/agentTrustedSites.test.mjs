/**
 * TRUSTED SITES (`src/agent/trustedSites.js`).
 *
 * The address guard lets the model open only addresses it was given. A setup
 * may name trusted sites whose pages it can open on its own, so Tex can go to
 * chatgpt.com/auth/login mid-setup. These checks prove the widening is no
 * wider: a lookalike host, a query string, a port or credentials are still
 * refused, and an address on an untrusted site is refused as before.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_PAGE_TOOL, webSession } from "../src/agent/computer.js";
import { parseSetup } from "../src/agent/production.js";
import { OpenableAddresses, onTrustedSite, readTrustedSites } from "../src/agent/trustedSites.js";

const SITES = ["chatgpt.com", "openai.com", "claude.ai", "context.lc"];

function fakeComputer() {
  const opened = [];
  return {
    opened,
    async readPage(url) {
      opened.push(url);
      return { url, title: "Page", text: "hello", links: [] };
    },
  };
}

function setupFile(trusted) {
  return [
    "---",
    "job: texting-assistant",
    "models:",
    "  main: anthropic/claude-haiku-5-5",
    ...(trusted === undefined ? [] : [`trusted_sites: ${trusted}`]),
    "---",
    "",
    "You are Tex.",
  ].join("\n");
}

/* ---------------- the setup's list ---------------- */

test("readTrustedSites reads hostnames and lowercases them", () => {
  assert.deepEqual(readTrustedSites(["ChatGPT.com", "auth.openai.com", "chatgpt.com"]), ["chatgpt.com", "auth.openai.com"]);
  assert.deepEqual(readTrustedSites(undefined), []);
});

for (const [name, value] of [
  ["a bare word", ["localhost"]],
  ["a wildcard", ["*.openai.com"]],
  ["an address with a path", ["chatgpt.com/auth"]],
  ["an address with a scheme", ["https://chatgpt.com"]],
  ["a port", ["chatgpt.com:8443"]],
  ["a map instead of a list", { "chatgpt.com": "yes" }],
  ["more than twenty sites", Array.from({ length: 21 }, (_, i) => `s${i}.example.com`)],
]) {
  test(`readTrustedSites refuses ${name}`, () => {
    assert.equal(readTrustedSites(value), null);
  });
}

test("parseSetup reads trusted_sites, and a setup without it trusts nothing", async () => {
  assert.deepEqual((await parseSetup(setupFile("[chatgpt.com, claude.ai]"))).trustedSites, ["chatgpt.com", "claude.ai"]);
  assert.deepEqual((await parseSetup(setupFile())).trustedSites, []);
});

test("parseSetup refuses the whole setup when trusted_sites is invalid", async () => {
  assert.equal(await parseSetup(setupFile("[*.chatgpt.com]")), null);
});

/* ---------------- what a trusted site lets through, and what it does not ---------------- */

test("a page on a trusted site or its subdomain is openable", () => {
  assert.equal(onTrustedSite("https://chatgpt.com/auth/login", SITES), true);
  assert.equal(onTrustedSite("https://auth.openai.com/log-in", SITES), true);
  assert.equal(onTrustedSite("https://claude.ai/customize/connectors", SITES), true);
});

for (const [name, url] of [
  ["a lookalike that ends in the trusted name", "https://chatgpt.com.attacker.example/login"],
  ["a host that merely contains the name", "https://evilchatgpt.com/login"],
  ["a query string the model could write notes into", "https://chatgpt.com/?q=the%20person%27s%20notes"],
  ["an empty query", "https://chatgpt.com/?"],
  ["credentials in the address", "https://user:pass@chatgpt.com/"],
  ["a port", "https://chatgpt.com:8443/"],
  ["plain http", "http://chatgpt.com/"],
  ["an untrusted site", "https://attacker.example/"],
]) {
  test(`a trusted list does not let through ${name}`, () => {
    assert.equal(onTrustedSite(url, SITES), false);
  });
}

test("OpenableAddresses keeps exact addresses and adds trusted sites only once trusted", () => {
  const allowed = new OpenableAddresses(["https://example.com/given"]);
  assert.equal(allowed.has("https://example.com/given"), true);
  assert.equal(allowed.has("https://chatgpt.com/auth/login"), false);
  allowed.trust(SITES);
  assert.equal(allowed.has("https://chatgpt.com/auth/login"), true);
  assert.equal(allowed.has("https://chatgpt.com/?q=notes"), false);
});

/* ---------------- end to end through the guard ---------------- */

test("open_page refuses chatgpt.com/auth/login until the setup trusts chatgpt.com", async () => {
  const computer = fakeComputer();
  const session = webSession(computer, "connect my ChatGPT");
  const before = await session.call(OPEN_PAGE_TOOL, { urls: ["https://chatgpt.com/auth/login"] });
  assert.equal(before.isError, true);
  assert.deepEqual(computer.opened, []);

  session.trust(SITES);
  const after = await session.call(OPEN_PAGE_TOOL, { urls: ["https://chatgpt.com/auth/login"] });
  assert.notEqual(after.isError, true);
  assert.deepEqual(computer.opened, ["https://chatgpt.com/auth/login"]);
});

test("a trusted site never carries a query the model wrote, and other sites stay closed", async () => {
  const computer = fakeComputer();
  const session = webSession(computer, "connect my ChatGPT");
  session.trust(SITES);
  for (const url of ["https://chatgpt.com/?q=salary%20is%20120k", "https://attacker.example/?q=notes"]) {
    const result = await session.call(OPEN_PAGE_TOOL, { urls: [url] });
    assert.equal(result.isError, true, url);
  }
  assert.deepEqual(computer.opened, []);
});

/* ---------------- open web (owner, 2026-10-11) ---------------- */

test("parseSetup reads open_web, off by default, and refuses a value it does not know", async () => {
  const file = (line) => setupFile().replace("---\n\nYou", `${line}\n---\n\nYou`);
  assert.equal((await parseSetup(setupFile())).openWeb, false);
  assert.equal((await parseSetup(file("open_web: yes"))).openWeb, true);
  assert.equal(await parseSetup(file("open_web: maybe")), null);
});

test("with open web, any public https address opens, with or without a query", () => {
  const allowed = new OpenableAddresses();
  assert.equal(allowed.has("https://news.example.org/story?id=4"), false);
  allowed.openWeb(true);
  assert.equal(allowed.has("https://news.example.org/story?id=4"), true);
  assert.equal(allowed.has("https://chatgpt.com/auth/login"), true);
});

for (const [name, url] of [
  ["a bare IP address", "https://10.0.0.1/admin"],
  ["an IPv6 address", "https://[::1]/"],
  ["an internal name", "https://intranet.corp/"],
  ["localhost", "https://localhost/"],
  ["a port", "https://example.org:8443/"],
  ["credentials", "https://user:pass@example.org/"],
]) {
  test(`open web still refuses ${name}`, () => {
    const allowed = new OpenableAddresses();
    allowed.openWeb(true);
    assert.equal(allowed.has(url), false);
  });
}

test("open_page opens an address the model chose only when the setup opens the web", async () => {
  const computer = fakeComputer();
  const session = webSession(computer, "find me the delta baggage policy");
  const url = "https://www.delta.com/us/en/baggage/overview";
  assert.equal((await session.call(OPEN_PAGE_TOOL, { urls: [url] })).isError, true);
  session.trust([], { openWeb: true });
  assert.notEqual((await session.call(OPEN_PAGE_TOOL, { urls: [url] })).isError, true);
  assert.deepEqual(computer.opened, [url]);
});
