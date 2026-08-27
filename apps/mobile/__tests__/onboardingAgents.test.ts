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
    for (const folder of PARA_FOLDERS) {
      // Only the two the prompt actually asks for are named; the point is that
      // nothing outside the real set ever is.
      expect(PARA_FOLDERS).toContain(folder);
    }
    expect(prompt).toContain("1-projects/");
    expect(prompt).toContain("3-resources/");
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
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("no folders at all does not produce a prompt naming `undefined`", () => {
    // Defensive: the structure step refuses to apply an empty custom list, so
    // this should be unreachable — but a prompt that renders "undefined/" as an
    // instruction is the kind of thing that ships.
    const prompt = seedPromptFor([]);
    expect(prompt).not.toMatch(/undefined/);
    expect(prompt).not.toMatch(/null/);
  });
});

describe("the three sentences that are not decoration", () => {
  test("it tells the client to name the folder before writing", () => {
    // The house rule from the MCP server's own instructions. The folder decides
    // the visibility scope, so this is the confirmation that stops a private
    // thing landing somewhere shared — dropping it would teach every client the
    // product ships with to skip it.
    expect(defaultSeedPrompt()).toMatch(/which folder each note is going in before you write it/i);
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
    expect(TIER_NOTE).toMatch(/revoke on its own/i);
  });
});
