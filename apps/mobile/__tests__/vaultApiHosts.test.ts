import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DIRECTORY_APIS } from "../features/vault/apiHosts.generated";
import { TOP_APIS } from "../features/vault/apiHostsTop";
import { apiForName, knownApiCount, suggestApiHosts } from "../features/vault/apiHostSuggest";
import { SHARED_HOST_SUFFIXES, guessStyle, hostProblem, typedHost } from "../features/vault/vaultProxy";

/**
 * "Only ever sent to" suggests API websites as the person types. These prove
 * the list is big, clean and never offers a host Save would refuse, and that
 * the hand-picked APIs come first.
 */

const directoryHosts = DIRECTORY_APIS.split("\n").map((line) => line.split("|")[0]);
const everyHost = [...TOP_APIS.map(([host]) => host), ...directoryHosts];

describe("the list", () => {
  test("knows over a thousand APIs, each listed once", () => {
    expect(knownApiCount()).toBeGreaterThanOrEqual(1000);
    expect(new Set(everyHost).size).toBe(everyHost.length);
  });

  test("every host is one a key can be pinned to, written the way the server reads it", () => {
    for (const host of everyHost) {
      expect([host, hostProblem(host)]).toEqual([host, null]);
      expect(typedHost(host)).toBe(host);
    }
  });

  test("every hand-picked style is one the server can send", () => {
    for (const [host, , how] of TOP_APIS) {
      if (how === undefined) continue;
      const [kind, name] = how.split(":");
      expect([host, kind]).toEqual([host, expect.stringMatching(/^(header|query)$/)]);
      expect(name).toMatch(kind === "header" ? /^[A-Za-z0-9-]{1,64}$/ : /^[A-Za-z0-9_.-]{1,64}$/);
      expect(guessStyle(host)).toEqual({ style: kind, name });
    }
  });

  test("the shared-host list is the gateway's, word for word", () => {
    const source = readFileSync(join(__dirname, "../../mcp/src/vault/proxy.js"), "utf8");
    const block = source.match(/const SHARED_SUFFIXES = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    expect([...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...SHARED_HOST_SUFFIXES]);
  });
});

describe("suggestions as you type", () => {
  const hosts = (typed: string) => suggestApiHosts(typed).map((api) => api.host);

  test("a name finds its API, hand-picked first", () => {
    expect(hosts("stripe")[0]).toBe("api.stripe.com");
    expect(hosts("openai")[0]).toBe("api.openai.com");
    expect(hosts("anthr")[0]).toBe("api.anthropic.com");
    expect(hosts("gemini")[0]).toBe("generativelanguage.googleapis.com");
  });

  test("the start of an address finds it, with or without https://", () => {
    expect(hosts("api.git")).toContain("api.github.com");
    expect(hosts("https://api.res")[0]).toBe("api.resend.com");
  });

  test("at most five, and none once the address is exactly one of them or nothing is typed", () => {
    expect(suggestApiHosts("api").length).toBe(5);
    expect(suggestApiHosts("api.stripe.com")).toEqual([]);
    expect(suggestApiHosts("  ")).toEqual([]);
  });

  test("the directory fills in what was not hand-picked", () => {
    expect(hosts("sheets")).toContain("sheets.googleapis.com");
    expect(suggestApiHosts("zzzzqqq")).toEqual([]);
  });
});

describe("the one-tap suggestion from the key's name", () => {
  test("a known name or its dashboard points at the API", () => {
    expect(apiForName("Stripe")?.host).toBe("api.stripe.com");
    expect(apiForName("My OpenAI key")?.host).toBe("api.openai.com");
    expect(apiForName("Claude")?.host).toBe("api.anthropic.com");
    expect(apiForName("Payments", "dashboard.stripe.com")?.host).toBe("api.stripe.com");
  });

  test("a vague name offers nothing rather than a guess", () => {
    expect(apiForName("Work key")).toBeNull();
    expect(apiForName("")).toBeNull();
    expect(apiForName("Key", "example.co.uk")).toBeNull();
  });
});

describe("the website, checked as it is typed", () => {
  test("a host anyone can publish under is refused in the server's words", () => {
    expect(hostProblem("myapp.vercel.app")).toMatch(/^Anyone can put a page on myapp\.vercel\.app/);
    expect(hostProblem("https://x.workers.dev/hook")).toMatch(/Anyone/);
  });

  test("what isn't a website is said; a real one and an empty field are fine", () => {
    expect(hostProblem("stripe")).toMatch(/like api\.example\.com/);
    expect(hostProblem("10.0.0.1")).toMatch(/like api\.example\.com/);
    expect(hostProblem("api.example.com:8443")).toMatch(/like api\.example\.com/);
    expect(hostProblem("user:pw@api.example.com")).toMatch(/like api\.example\.com/);
    expect(hostProblem("https://api.example.com/v1")).toBeNull();
    expect(hostProblem("")).toBeNull();
  });
});
