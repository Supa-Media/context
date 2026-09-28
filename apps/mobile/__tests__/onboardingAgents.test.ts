import { describe, expect, test } from "@jest/globals";
import {
  BOOTSTRAP_PROMPT,
  ENDPOINT_NOTE,
  ORIENT_TOOL,
  TIER_NOTE,
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

/*
  The folder-aware seed prompt these tests used to pin went with the old tools
  step. Its guardrails did not: the bootstrap prompt is now the one first-run
  instruction a client receives, and it has to keep every one of them.
*/
describe("the bootstrap prompt keeps the guardrails", () => {
  const prompt = BOOTSTRAP_PROMPT.replace(/\s+/g, " ");

  test("it never aims a client at a file Context maintains", () => {
    expect(prompt).toMatch(/never touch index\.md or privacy\.md/);
  });

  test("it runs through without stopping for a go, and goes deep", () => {
    expect(prompt).not.toMatch(/wait for my go/i);
    expect(prompt).toMatch(/don't stop to ask me for confirmation/i);
    expect(prompt).toMatch(/cover every project, area and person/i);
  });

  test("it tells the client to name the folder of each note", () => {
    expect(prompt).toMatch(/tell me which folder each note is going in/i);
  });

  test("it asks for short and factual notes", () => {
    expect(prompt).toMatch(/short and factual/i);
  });

  test("it calls the tool the gateway actually exposes, first", () => {
    expect(ORIENT_TOOL).toBe("orient");
    expect(prompt).toContain(`call \`${ORIENT_TOOL}\` first`);
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
