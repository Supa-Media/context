/**
 * Which folder a context archives into, and the two implementations of it.
 *
 * `archive_note` and the console's archive button were both written against a
 * literal `4-archive`, and they disagreed about what to do when a context did
 * not have one: the gateway refused, the console created it. That was
 * survivable while `4-archive` was the only archive this product shipped. It
 * stopped being survivable when the `company` preset shipped `5-archive` and
 * became the default layout for a shared workspace — so the most common shared
 * context we create had a folder plainly named the archive, in its own root
 * listing, that Claude refused to use and the console silently opened a second
 * archive beside.
 *
 * What is proved here:
 *
 *  1. the resolver recognises the archive roots this product ships, and the
 *     shapes an owner would obviously mean, without guessing at synonyms;
 *  2. a context that already has `4-archive` never has its archive moved by
 *     the widening — the whole installed base is unaffected;
 *  3. the gateway's resolver and the console's mirror agree over every one of
 *     these manifests, driven rather than restated;
 *  4. "already archived" is measured against every archive a context has, not
 *     the one that would be written to.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import {
  archiveRoot,
  archiveRoots,
  insideArchive,
  type PrivacyRule,
  type Visibility,
} from "../functions/lib/privacy";
import { gatewayInternals } from "./gatewayFormat.helpers";

const rulesFor = (...prefixes: string[]): PrivacyRule[] =>
  prefixes.map((prefix) => ({ prefix, vis: "private" as Visibility }));

/** The manifests both implementations are driven over, named for the failure. */
const MANIFESTS: { why: string; prefixes: string[]; root: string | null }[] = [
  { why: "the PARA scaffold", prefixes: ["0-inbox", "1-projects", "4-archive"], root: "4-archive" },
  {
    why: "the company preset, the default shared layout and the bug",
    prefixes: ["0-inbox", "1-projects", "2-teams", "3-handbook", "4-customers", "5-archive"],
    root: "5-archive",
  },
  { why: "the client preset", prefixes: ["1-clients", "2-pipeline", "4-archive"], root: "4-archive" },
  { why: "an owner who just called it what it is", prefixes: ["Notes", "archive"], root: "archive" },
  { why: "and capitalised it", prefixes: ["Notes", "Archive"], root: "Archive" },
  { why: "a number nobody ships", prefixes: ["9-archive"], root: "9-archive" },
  {
    why: "a rule naming something inside the archive still says it exists",
    prefixes: ["4-archive/chat-history"],
    root: "4-archive",
  },
  /*
   * Two roots, both directions. These are in the shared battery rather than
   * only in the console's own describe block below, and that is a correction:
   * with one root per manifest the differential compared two resolvers that
   * could not disagree, and breaking the gateway's preference deliberately
   * left all eighteen checks green. A guard nobody has checked is not a guard.
   */
  {
    why: "a PARA context that later gained a second archive keeps its own",
    prefixes: ["1-projects", "4-archive", "5-archive"],
    root: "4-archive",
  },
  {
    why: "declared the other way round, same answer",
    prefixes: ["5-archive", "4-archive"],
    root: "4-archive",
  },
  {
    why: "two archives, neither of them the PARA one",
    prefixes: ["9-archive", "5-archive"],
    root: "5-archive",
  },
  { why: "a custom layout with no archive at all", prefixes: ["Journal", "Clients"], root: null },
  { why: "no rules at all", prefixes: [], root: null },
  /*
   * The line this refuses to cross. These are all words for "inactive", and a
   * folder name is not enough to know one is meant — inventing a destination
   * in somebody's bucket is what refusing was right about, and widening the
   * shape must not quietly turn into guessing at synonyms.
   */
  { why: "a synonym is not an archive", prefixes: ["retired", "old", "cold-storage"], root: null },
  { why: "nor is a word that merely contains it", prefixes: ["archived", "archives", "my-archive-notes"], root: null },
];

describe("the archive a context actually has", () => {
  for (const { why, prefixes, root } of MANIFESTS) {
    test(`${why} resolves to ${root ?? "no archive"}`, () => {
      expect(archiveRoot(rulesFor(...prefixes))).toBe(root);
    });
  }
});

describe("nothing that already had an archive is moved", () => {
  /**
   * The installed base, stated as a property rather than a case. `4-archive`
   * wins whenever it is declared at all, so a PARA context that later gains a
   * second archive keeps filing where its history already is.
   */
  test("`4-archive` wins over any other root beside it", () => {
    expect(archiveRoot(rulesFor("4-archive", "5-archive"))).toBe("4-archive");
    expect(archiveRoot(rulesFor("5-archive", "4-archive"))).toBe("4-archive");
    expect(archiveRoot(rulesFor("archive", "4-archive", "9-archive"))).toBe("4-archive");
  });

  /**
   * And with no `4-archive` in sight the answer is a property of the set, not
   * of the order — an owner reordering `privacy.md` must not repoint archiving.
   */
  test("the choice does not depend on manifest order", () => {
    expect(archiveRoot(rulesFor("9-archive", "5-archive"))).toBe(
      archiveRoot(rulesFor("5-archive", "9-archive")),
    );
    expect(archiveRoot(rulesFor("9-archive", "5-archive"))).toBe("5-archive");
  });
});

describe("already archived means any of them", () => {
  test("a note in a second archive is not moved into the preferred one", () => {
    const roots = archiveRoots(rulesFor("4-archive", "5-archive"));
    expect(insideArchive("5-archive/2026/note.md", roots)).toBe(true);
    expect(insideArchive("4-archive/2026/note.md", roots)).toBe(true);
    expect(insideArchive("1-projects/note.md", roots)).toBe(false);
  });

  test("the folder itself counts, and a lookalike sibling does not", () => {
    const roots = archiveRoots(rulesFor("4-archive"));
    expect(insideArchive("4-archive", roots)).toBe(true);
    expect(insideArchive("4-archive-old/note.md", roots)).toBe(false);
  });
});

/**
 * The differential guard, on `scaffold.test.ts`'s model: the gateway's real
 * resolver, extracted from its source, against the console's mirror in
 * `lib/privacy.ts`. Two copies that drift put one bucket's archive in two
 * folders depending on which surface the person used, and neither surface
 * would report anything wrong.
 */
describe("the gateway and the console resolve the same folder", () => {
  test("over every manifest above", () => {
    const gateway = gatewayInternals();
    for (const { why, prefixes, root } of MANIFESTS) {
      const rules = rulesFor(...prefixes);
      expect(gateway.archiveRoot(rules), why).toBe(root);
      expect(gateway.archiveRoot(rules), why).toBe(archiveRoot(rules));
      expect(gateway.archiveRoots(rules), why).toEqual(archiveRoots(rules));
    }
  });

  /**
   * Non-vacuity: prove the extraction produced the real function rather than
   * an `undefined` that every `toBe` above would have compared happily.
   */
  test("and the extracted resolver is the real one", () => {
    const gateway = gatewayInternals();
    expect(typeof gateway.archiveRoot).toBe("function");
    expect(gateway.archiveRoot(rulesFor("5-archive"))).toBe("5-archive");
    expect(gateway.archiveRoot(rulesFor("Journal"))).toBeNull();
  });

  /** And the session folder follows the archive, which is the same question. */
  test("and the session fallback follows it", () => {
    const { defaultSessionFolder } = gatewayInternals();
    expect(defaultSessionFolder(rulesFor("4-archive"))).toBe("4-archive/chat-history");
    expect(defaultSessionFolder(rulesFor("5-archive"))).toBe("5-archive/chat-history");
    expect(defaultSessionFolder(rulesFor("Journal"))).toBe("0-inbox/sessions");
  });
});
