/**
 * @jest-environment jsdom
 */

/**
 * Who may be asked to suggest, and what they are told.
 *
 * ## The gate this file exists for
 *
 * A suggestion query carries **a line of the person's note** into a plugin's
 * sandbox. That is note *content*, which is a stronger disclosure than anything
 * the host has pushed to a guest before — `active-file` and `vault-event` carry
 * a path, and `maySeePaths` gates those on `vault:read` **or** `metadata:read`.
 *
 * Content is not metadata. A plugin granted `metadata:read` was approved to see
 * frontmatter, headings, tags and links; it was not approved to read the
 * sentence somebody is in the middle of typing. So the suggestion gate is
 * `vault:read` alone, and it is a different function from `maySeePaths` rather
 * than a reuse of it — the two answer different questions and would drift into
 * each other if they shared a name.
 *
 * The guest cannot enforce this. It is handed the line before it runs any
 * plugin code, so the only place the decision can live is the trusted side,
 * before the message is sent.
 */

import { describe, expect, test } from "@jest/globals";
import {
  maySeeContent,
  maySeePaths,
  suggestFor,
  freshSuggestions,
} from "../features/console/plugins/runtime";
import type { PluginGrant } from "../features/console/plugins/grants";

const BUNDLE = { pluginId: "youversion-linker", bundleFingerprint: "fp-1" };

function grant(capabilities: PluginGrant["capabilities"], over: Partial<PluginGrant> = {}): PluginGrant {
  return {
    pluginId: "youversion-linker",
    bundleFingerprint: "fp-1",
    capabilities,
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("a line of somebody's note only reaches a plugin allowed to read notes", () => {
  test("vault:read is the grant that opens it", () => {
    expect(maySeeContent(BUNDLE, [grant(["vault:read"])])).toBe(true);
  });

  /*
    The distinction this whole file is for. `maySeePaths` says yes to
    metadata:read because a path is metadata-shaped; a line of prose is not.
    Asserting both here keeps the two from being "simplified" into one.
  */
  test("metadata:read is enough for a path and not for a line", () => {
    const grants = [grant(["metadata:read"])];
    expect(maySeePaths(BUNDLE, grants)).toBe(true);
    expect(maySeeContent(BUNDLE, grants)).toBe(false);
  });

  test("a plugin with only its own settings is never asked", () => {
    expect(maySeeContent(BUNDLE, [grant(["settings:read", "settings:write"])])).toBe(false);
  });

  test("a revoked grant reads notes no longer", () => {
    expect(maySeeContent(BUNDLE, [grant(["vault:read"], { status: "revoked" })])).toBe(false);
  });

  test("a grant for another bundle of the same plugin is not this bundle's", () => {
    expect(maySeeContent(BUNDLE, [grant(["vault:read"], { bundleFingerprint: "fp-other" })]))
      .toBe(false);
  });

  /*
    Fails closed while the query is in flight, like every other grant read in
    this console. A line sent a moment early cannot be recalled.
  */
  test("grants that have not answered yet mean nobody is asked", () => {
    expect(maySeeContent(BUNDLE, undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("a query reaches one frame, and a stale answer reaches nobody", () => {
  const sandbox = { bundle: { pluginId: "youversion-linker" }, nonce: "frame-1" };

  test("the frame it was addressed to gets it", () => {
    expect(suggestFor(sandbox, { seq: 4, pluginId: "youversion-linker", nonce: "frame-1", line: "@ John", ch: 6 }))
      .toEqual({ seq: 4, line: "@ John", ch: 6 });
  });

  /*
    The rule #533 established for commands, applied to the other instruction in
    this protocol: a restart mounts a new frame, and a query aimed at the frame
    before it is not owed to its successor. A suggester that answered it would
    be completing against a line the person has since left.
  */
  test("a replacement frame does not inherit its predecessor's query", () => {
    expect(suggestFor(sandbox, { seq: 4, pluginId: "youversion-linker", nonce: "frame-0", line: "@ John", ch: 6 }))
      .toBeUndefined();
  });

  test("another plugin's frame never sees it", () => {
    expect(suggestFor({ bundle: { pluginId: "other" }, nonce: "frame-1" }, {
      seq: 4, pluginId: "youversion-linker", nonce: "frame-1", line: "@ John", ch: 6,
    })).toBeUndefined();
  });

  /*
    Typing outruns a round trip. A menu built from an answer to a line the
    cursor has already left is worse than no menu: it offers completions for
    text that is no longer there, and the person accepts one into the text that
    is.
  */
  test("an answer for an older query is dropped", () => {
    expect(freshSuggestions({ seq: 7, items: [{ text: "John 3:16" }] }, 7))
      .toEqual([{ text: "John 3:16" }]);
    expect(freshSuggestions({ seq: 6, items: [{ text: "John 3:16" }] }, 7)).toBeNull();
  });

  test("an answer with no query outstanding is dropped", () => {
    expect(freshSuggestions({ seq: 7, items: [] }, null)).toBeNull();
  });
});
