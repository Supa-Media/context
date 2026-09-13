/**
 * THE VENDORED BLOCKLIST IS WHAT ITS SOURCES SAY.
 *
 * A committed artifact rots the moment somebody edits it by hand, and this one
 * is a security control: a name quietly deleted from it is a name somebody can
 * register. So the generated file carries a digest of its own contents and this
 * recomputes it.
 *
 * **What that proves, and what it does not.** It proves the file was written by
 * `scripts/build-reserved-names.mjs` and not touched since. It does *not* prove
 * the vendored copy still matches upstream — those sources are remote and CI
 * has no network, which is the honest difference from
 * `editorBundle.test.ts`, whose inputs are repo files it can re-hash. Re-running
 * the script is what answers the upstream question; the recorded version and
 * digest per source are what make that diff readable.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  VENDORED_BLOCKLIST,
  VENDORED_BLOCKLIST_DIGEST,
  VENDORED_BLOCKLIST_SOURCES,
} from "../functions/lib/reservedNames.generated";
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, RESERVED_NAMES, validateName } from "../functions/lib/names";

describe("the generated file", () => {
  test("has not been edited by hand", () => {
    const digest = createHash("sha256").update(VENDORED_BLOCKLIST.join("\n")).digest("hex");
    expect(digest).toBe(VENDORED_BLOCKLIST_DIGEST);
  });

  test("records where every name came from, so it can be re-synced", () => {
    expect(VENDORED_BLOCKLIST_SOURCES.length).toBeGreaterThan(0);
    for (const source of VENDORED_BLOCKLIST_SOURCES) {
      expect(source.url).toMatch(/^https:\/\//);
      // 64 hex characters. A truncated or absent digest would make a re-sync
      // diff unreadable, which is the only thing the record is for.
      expect(source.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(source.version).not.toBe("");
    }
  });

  test("is sorted and free of duplicates, so a diff after a re-sync is readable", () => {
    expect([...VENDORED_BLOCKLIST]).toEqual([...VENDORED_BLOCKLIST].sort());
    expect(new Set(VENDORED_BLOCKLIST).size).toBe(VENDORED_BLOCKLIST.length);
  });

  /*
    Every vendored name has to be one this namespace could actually have
    handed out. An entry that `validateName` would refuse anyway — `_domainkey`,
    a 40-character cipher suite, a single character — is not protection, it is
    noise that makes the real entries harder to audit. The generator drops
    them; this is the assertion that it did.
  */
  test("holds only names that were claimable in the first place", () => {
    for (const name of VENDORED_BLOCKLIST) {
      expect({ name, ok: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) }).toEqual({ name, ok: true });
      expect(name.length).toBeGreaterThanOrEqual(NAME_MIN_LENGTH);
      expect(name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    }
  });

  test("and every one of them is actually refused", () => {
    // The list is only a list until something reads it. `RESERVED_NAMES`
    // spreads it in; this is the proof that the spread reached the validator
    // rather than a set nothing consults.
    for (const name of VENDORED_BLOCKLIST) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
      expect({ name, ...validateName(name) }).toMatchObject({ name, ok: false, reason: "reserved" });
    }
  });
});
