/**
 * A colon in a path, and a manifest that would not read back.
 *
 * Production, 2026-10-14: a private meeting note under
 * `2-areas/meetings/1:1s/<a>:<b>/` had its exception written to `privacy.md`
 * as `  2-areas/meetings/1:1s/<a>:<b>/<note>.md: private`. Both parsers read
 * the visibility from the FIRST colon, rejected the line, and with it the
 * whole file: every note in the workspace failed closed, every share stopped,
 * and the console offered "Reset privacy.md" — which would have rewritten
 * every folder as private.
 *
 * Two fixes, each pinned here: the parsers read the visibility from the LAST
 * colon, and the one function every rewrite goes through refuses to produce a
 * manifest that does not parse.
 */
import { describe, expect, test } from "vitest";
import {
  PrivacyOverrides,
  UnreadableManifestError,
  effectiveVisibility,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
} from "../../functions/lib/privacy";
import { mutateManifest } from "../../functions/lib/fileOps/privacyRewrite";
import { FileOpError } from "../../functions/lib/fileOps/errors";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { memoryStore } from "../storeStub.helpers";
import { gateway, manifest, block } from "./fixtures.helpers";

const MEETING = "2-areas/meetings/1:1s/ana:ben/2026-10-14-ana-ben-f14w3eb3.md";

const WITH_COLON = manifest(
  block([
    "default_visibility: private",
    "",
    "folder_defaults:",
    "  2-areas: team",
    "",
    "note_overrides:",
    `  ${MEETING}: private`,
  ]),
);

describe("a colon belongs to the path", () => {
  test("both engines read the rule, with the visibility after the last colon", () => {
    for (const parse of [parsePrivacyManifest, gateway.parsePrivacyManifest]) {
      const parsed = parse(WITH_COLON);
      expect(parsed.rules).toEqual([{ prefix: "2-areas", vis: "team" }]);
      expect(parsed.overrides.get(MEETING)).toBe("private");
    }
  });

  test("the exception still narrows the note it names", () => {
    const parsed = parsePrivacyManifest(WITH_COLON);
    expect(effectiveVisibility(MEETING, parsed.rules, parsed.overrides)).toBe("private");
    expect(effectiveVisibility("2-areas/other.md", parsed.rules, parsed.overrides)).toBe("team");
  });

  test("a folder whose name ends like a rule still reads as the whole name", () => {
    // `foo: private: team` is the folder `foo: private`, shared — never the
    // folder `foo` made private with a stray word after it.
    const text = manifest(block(["default_visibility: private", "", "folder_defaults:", "  foo: private: team"]));
    for (const parse of [parsePrivacyManifest, gateway.parsePrivacyManifest]) {
      expect(parse(text).rules).toEqual([{ prefix: "foo: private", vis: "team" }]);
    }
  });

  test("a rewrite renders a colon path that reads back as itself", () => {
    const overrides = new PrivacyOverrides([[MEETING, "private"]]);
    for (const replace of [replacePrivacyRulesBlock, gateway.replacePrivacyRulesBlock]) {
      const next = replace(WITH_COLON, [{ prefix: "2-areas", vis: "team" }], overrides);
      expect(parsePrivacyManifest(next).overrides.get(MEETING)).toBe("private");
    }
  });
});

describe("a manifest that would not read back is never written", () => {
  // `#` starts a comment, so this path's rule loses everything after it.
  const UNREADABLE = "2-areas/notes#1.md";

  test("both engines refuse to render it", () => {
    const overrides = new PrivacyOverrides([[UNREADABLE, "private"]]);
    expect(() => replacePrivacyRulesBlock(WITH_COLON, [], overrides)).toThrow(UnreadableManifestError);
    expect(() => gateway.replacePrivacyRulesBlock(WITH_COLON, [], overrides)).toThrow(/would not read back/);
  });

  test("the console's rewrite answers PATH_INVALID and leaves the file alone", async () => {
    const store = memoryStore();
    store.seed(PRIVACY_KEY, WITH_COLON);
    const attempt = mutateManifest(store as never, ({ rules, overrides }) => {
      const next = new Map(overrides);
      next.set(UNREADABLE, "private");
      return { rules, overrides: next };
    });
    await expect(attempt).rejects.toBeInstanceOf(FileOpError);
    await expect(attempt).rejects.toMatchObject({ code: "PATH_INVALID" });
    expect(store.snapshot()[PRIVACY_KEY]).toBe(WITH_COLON);
  });
});
