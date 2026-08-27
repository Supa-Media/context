import { describe, expect, test } from "@jest/globals";
import { PARA_FOLDERS } from "@context/convex/functions/lib/scaffold";
import {
  ENDPOINT_NOTE,
  ORIENT_TOOL,
  TIER_NOTE,
  defaultSeedPrompt,
  seedPromptFor,
} from "../features/onboarding/agents";

/**
 * The prompt handed to a connected AI client on the last real step of the run.
 *
 * This file exists because the prompt is the closest thing the app has to a
 * specification of how a client should behave on first contact, and it makes
 * three claims that live somewhere else: which tool to call, which folders
 * exist, and what a client is allowed to see. Every one of them can drift
 * silently — a renamed tool, a folder the person declined, a tier the consent
 * screen does not actually default to — and the failure is not a crash. It is
 * a prompt that quietly asks for something that is not there, in somebody
 * else's product, where we never see it.
 */

describe("the seed prompt names only folders that exist", () => {
  test("the standard layout is taken from the control plane, not a second copy", () => {
    // If PARA_FOLDERS changes upstream, this must move with it rather than
    // naming a folder the scaffold no longer writes.
    const prompt = defaultSeedPrompt();
    // Every folder the prompt names must be one the scaffold actually writes.
    // The previous version of this looped `expect(PARA_FOLDERS).toContain(f)`
    // over PARA_FOLDERS itself, which is `for all f in S: f in S` — it could
    // not fail, and left two hardcoded literals doing the only real work.
    const named = [...prompt.matchAll(/in `([^`]+)\/`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const folder of named) {
      expect(PARA_FOLDERS).toContain(folder);
    }
  });

  test("a custom layout is never told about folders it declined", () => {
    // The regression this prevents: somebody names two folders of their own on
    // the layout step and is then handed a prompt instructing their AI to file
    // things under `1-projects/`, which does not exist in their bucket.
    const prompt = seedPromptFor(["work", "reading"]);
    expect(prompt).toContain("work/");
    expect(prompt).toContain("reading/");
    for (const folder of PARA_FOLDERS) {
      expect(prompt).not.toContain(`${folder}/`);
    }
  });

  test("a single-folder layout still produces a usable prompt", () => {
    // `custom` with one folder is a real answer the structure step accepts, so
    // the prompt must not assume it has two to distribute work across.
    const prompt = seedPromptFor(["notes"]);
    expect(prompt).toContain("notes/");
    // Every task lands somewhere real, rather than one of them falling through
    // to a target the layout does not have.
    // All three land in the one folder that exists. The bug this replaced sent
    // the third to the root, which is where `index.md` lives.
    expect([...prompt.matchAll(/in `([^`]+)\/`/g)].map((m) => m[1]!)).toEqual([
      "notes",
      "notes",
      "notes",
    ]);
  });

  test("no folders at all names no folder, and does not fall back to the root", () => {
    // Defensive: the structure step refuses to apply an empty custom list, so
    // this should be unreachable — but a prompt that renders "undefined/" as an
    // instruction is the kind of thing that ships, and falling back to the root
    // would aim all three tasks at the two files this prompt forbids.
    const prompt = seedPromptFor([]);
    expect(prompt).not.toMatch(/undefined/);
    expect(prompt).not.toMatch(/null/);
    expect(prompt).not.toMatch(/`index\.md`:/);
    expect([...prompt.matchAll(/in `([^`]+)\/`/g)]).toHaveLength(0);
    expect(prompt).toMatch(/wherever you think it belongs/);
  });
});

describe("the three sentences that are not decoration", () => {
  test("it never aims a client at a file Context maintains", () => {
    // The bug this catches shipped in the first version of this prompt: task 1
    // said "`index.md` at the root — who I am". `index.md` is INDEX_KEY, the
    // context manifest, written by the scaffold and read back by `orient` —
    // and `write_note` only checks an etag when one is supplied. A client
    // obeying that instruction replaces the manifest with a biography on its
    // first call, while the next screen still calls it "yours to edit".
    const prompt = defaultSeedPrompt();
    expect(prompt).not.toMatch(/In .*index\.md/);
    expect(prompt).not.toMatch(/\d\.\s*`index\.md`/);
    expect(prompt).toMatch(/Do not change `index\.md` or `privacy\.md`/);
  });

  test("it waits for a go, rather than only announcing", () => {
    // "Tell me which folder, before you write it" is satisfied by a client
    // that announces and writes in the same turn, which is not a confirmation.
    expect(defaultSeedPrompt().replace(/\s+/g, " ")).toMatch(/wait for me to say go/i);
  });

  test("it gives a client that does not know the person somewhere to go", () => {
    // KNOWN_CLIENTS names clients with no cross-session memory. Without this
    // the honest one stalls and the eager one invents.
    expect(defaultSeedPrompt().replace(/\s+/g, " ")).toMatch(/ask me rather than guessing/i);
  });

  test("it tells the client to name the folder before writing", () => {
    // The house rule from the MCP server's own instructions. The folder decides
    // the visibility scope, so this is the confirmation that stops a private
    // thing landing somewhere shared — dropping it would teach every client the
    // product ships with to skip it.
    expect(defaultSeedPrompt().replace(/\s+/g, " ")).toMatch(/tell me which folder each note is going in/i);
  });

  test("it asks for short and factual notes", () => {
    // Without this the first thing in a brand-new context is a thousand words
    // of flattering summary, which is what people delete and never return to.
    expect(defaultSeedPrompt()).toMatch(/short and factual/i);
  });

  test("it leaves a standing instruction, not just a one-off import", () => {
    // The seeding is the demo. This is the line that makes it a habit.
    const prompt = defaultSeedPrompt();
    expect(prompt).toMatch(/from now on/i);
    expect(prompt).toMatch(/check Context before answering/i);
  });

  test("it calls the tool the gateway actually exposes", () => {
    expect(ORIENT_TOOL).toBe("orient");
    expect(defaultSeedPrompt()).toContain(`\`${ORIENT_TOOL}\``);
  });
});

describe("what the screen says about the endpoint and the tier", () => {
  test("the grant sentence is said once, not twice on one screen", () => {
    // Both notes render together in AgentsStep. They used to open with the same
    // clause in different words, which reads as two different promises.
    expect(ENDPOINT_NOTE).toMatch(/gets its own grant/);
    expect(TIER_NOTE).not.toMatch(/gets its own grant/);
  });

  test("the endpoint is described as shared, because it is", () => {
    // People expect a personal URL and reach for the wrong mental model when
    // they do not get one. The recurring question is "is this someone else's?".
    expect(ENDPOINT_NOTE).toMatch(/same URL for everyone/i);
    expect(ENDPOINT_NOTE).toMatch(/nothing in the address identifies you/i);
  });

  test("the tier note says team is the default, including for the owner", () => {
    // The consent screen defaults every grant to `team` — owners included,
    // because approving private access is an opt-in. A first-run screen
    // implying a connected client sees everything would describe a product we
    // deliberately do not ship.
    expect(TIER_NOTE).toMatch(/team is the default/i);
    expect(TIER_NOTE).toMatch(/including for you/i);
  });

  test("neither note promises a grant that cannot be revoked on its own", () => {
    expect(TIER_NOTE).toMatch(/revoke any client on its own/i);
    // And it says where, which it did not.
    expect(TIER_NOTE).toMatch(/Connections/);
  });
});
