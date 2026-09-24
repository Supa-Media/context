import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  copyPath,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
  writeFile,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
} from "../../functions/lib/privacy";
import {
  NOW,
  bucket,
  shareProjects,
  capture,
  errorShape,
} from "./fixtures";

describe("three guards that no test was holding", () => {
  /**
   * All three of these mutated to **zero** failures across the whole suite
   * before this block existed: `movePath`'s `canSee(from)`, `copyPath`'s
   * `canSee(from)`, and `copyPath`'s `sources.length === 0`. Each was written
   * deliberately and each was doing real work — a guard nobody has checked is
   * not a guard, and the way that gets found is by breaking it on purpose.
   */

  test("a team caller cannot move a note they cannot see", async () => {
    // `2-areas` is private by default and `health.md` carries no exception, so
    // its privacy rests entirely on the folder rule — which the destination
    // does not have. Without the guard the note lands in a `team` folder with
    // nothing carried across and becomes readable.
    const store = bucket();
    await shareProjects(store);

    const refusal = await capture(() =>
      movePath(store, {
        from: "2-areas/health.md",
        to: "1-projects/leaked.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    const absent = await capture(() =>
      movePath(store, {
        from: "2-areas/never-existed.md",
        to: "1-projects/leaked.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["2-areas/health.md"]).toBeDefined();
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();
  });

  test("a team caller cannot copy a note they cannot see", async () => {
    // `copyPrivacy` carries an exact-note exception and nothing else, so a note
    // private by folder rule arrives at a `team` destination with no exception
    // at all. The copy is not a lesser harm than the move: it is the contents,
    // readable, and the original still in place to make it look untouched.
    const store = bucket();
    await shareProjects(store);

    const refusal = await capture(() =>
      copyPath(store, { from: "2-areas/health.md", to: "1-projects/leaked.md", clearance: clearanceOf("team") }),
    );
    const absent = await capture(() =>
      copyPath(store, {
        from: "2-areas/never-existed.md",
        to: "1-projects/leaked.md",
        clearance: clearanceOf("team"),
      }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();
    expect(
      (await capture(() => readFile(store, { path: "1-projects/leaked.md", clearance: clearanceOf("team") }))).code,
    ).toBe("FILE_NOT_FOUND");
  });

  test("copying a visible folder whose every note is hidden is not a quiet success", async () => {
    // The folder is `team` — the caller can see it — and everything inside it
    // carries a `private` exception, so the walk returns nothing. Without the
    // guard this answers `paths: []` and HTTP success, while a folder that was
    // never there answers `FILE_NOT_FOUND`. That difference is an existence
    // oracle for a folder whose entire contents are private.
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/hr/comp.md", "# Salaries\n\n200k\n");
    await setVisibility(store, {
      path: "1-projects/hr/comp.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const refusal = await capture(() =>
      copyPath(store, { from: "1-projects/hr", to: "1-projects/hr-copy", clearance: clearanceOf("team") }),
    );
    const absent = await capture(() =>
      copyPath(store, { from: "1-projects/nothing", to: "1-projects/hr-copy", clearance: clearanceOf("team") }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/hr-copy/comp.md"]).toBeUndefined();
  });
});

describe("a rule no survivor needs, told truthfully", () => {
  /**
   * `a rule no survivor needs is not retained` claimed to be the test a "keep
   * every rule under the folder" implementation fails. It is not: it moves at
   * owner scope, where `rulesSurvivorsRestOn` returns on its first line, and
   * `return [...candidates]` passes it. Its comment has been corrected.
   *
   * The drop *is* pinned, on the delete path, by `a rule no survivor rests on
   * is dropped, at team scope`. This adds the move path, which had none, and
   * one consequence that test does not reach: the rule left standing is on a
   * prefix inside the owner's private area, so a note the owner writes there
   * afterwards is readable by anyone with team access. Verified by substituting
   * `return [...candidates]` and watching this fail.
   */
  test("the moved folder's own rule does not stay behind on a private prefix", async () => {
    const store = bucket();
    await shareProjects(store);
    // Inside `2-areas`, which is private, one folder deliberately shared.
    store.seed("2-areas/mixed/public.md", "# Public\n");
    store.seed("2-areas/mixed/hr/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "2-areas/mixed",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "2-areas/mixed/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    await movePath(store, {
      from: "2-areas/mixed",
      to: "1-projects/renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    // The survivor is still hidden, and stays hidden. It does not
    // need `2-areas/mixed/hr: private` to be, because with `2-areas/mixed: team`
    // gone it rests on `2-areas: private` — which is exactly the reasoning
    // `rulesSurvivorsRestOn` does, and why it retains a rule only when removing
    // it would change what the survivor resolves to.
    expect(
      (await capture(() => readFile(store, { path: "2-areas/mixed/hr/secret.md", clearance: clearanceOf("team") })))
        .code,
    ).toBe("FILE_NOT_FOUND");
    // The rule no survivor rests on does not.
    expect(manifest).not.toContain("2-areas/mixed: team");
    // And the consequence, which is what makes this worth a test: the prefix
    // the caller emptied is back inside the owner's private area.
    await writeFile(store, {
      path: "2-areas/mixed/afterwards.md",
      text: "# Written later\n",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(
      (await capture(() => readFile(store, { path: "2-areas/mixed/afterwards.md", clearance: clearanceOf("team") })))
        .code,
    ).toBe("FILE_NOT_FOUND");
  });
});

/**
 * THE CONTROL PLANE'S HALF OF THE FOLDED-TWIN RULE.
 *
 * `setVisibility` used to answer with `options.visibility` — the value it was
 * ASKED for, never re-derived — and the fold made that a lie. See "A privacy
 * decision is folded" in CLAUDE.md: the fold reads across case while the delete
 * writes exactly, so publishing a note whose case-twin is private removes
 * nothing, the manifest comes back identical, and the console reported the
 * publish as done over a note no team member could read.
 *
 * The re-derivation shipped unguarded for two rounds: restoring
 * `visibility: options.visibility` passed the whole suite, because a throw in
 * front of it made it a tautology. That throw is not in this change, so the
 * re-derivation is the whole of the story and is pinned below.
 */
describe("a set reports the manifest's answer", () => {
  /**
   * With no throw ahead of it, this is the whole of the folded-twin story on
   * the console side: the write really does nothing (the delete is exact, and
   * the note reads private through its twin's narrowing), so the ONLY thing
   * standing between the owner and a false "published" is that the answer is
   * read back off the manifest instead of echoed from the request.
   *
   * Refusing the write outright is better and is deliberately not in this
   * change — see the residual in CLAUDE.md.
   */
  test("a publish blocked by a case-twin reports private, not the team that was asked for", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/Pay.md", "# a different file, in a team folder\n");

    const result = await setVisibility(store, {
      path: "1-projects/Pay.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    // The request said team; the manifest still narrows it through pay.md.
    expect(result.visibility).toBe("private");
    // …and it really is unreadable at team scope, so the report is the truth.
    const refused = await capture(() =>
      readFile(store, { path: "1-projects/Pay.md", clearance: clearanceOf("team") }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
  });

  test("a no-op set reports the manifest's answer, not the request", async () => {
    const store = bucket();
    await shareProjects(store);
    const result = await setVisibility(store, {
      path: "1-projects/pay.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    expect(result.visibility).toBe("private");
    // These two are what the request cannot supply: they come from the rules.
    expect(result.inherited).toBe("team");
    expect(result.exception).toBe(true);
  });
});


/* -------------------------------------------------------------------------- */
/*                            an encrypted note                               */
/* -------------------------------------------------------------------------- */

/**
 * THE CONSOLE'S DOOR ONTO A NOTE THE CONSOLE CANNOT OPEN.
 *
 * `docs/decisions/encryption.md`. The gateway re-encrypts a write over an
 * encrypted note; this path cannot, because the control plane holds no key —
 * deliberately. So the only correct behaviour here is to show it locked and
 * refuse to write it, and the refusal is the half that matters: without it the
 * editor loads an envelope into a textarea and saves the result back as the
 * note's new plaintext, removing somebody's encryption by pressing Save through
 * a door the gateway's guard does not reach.
 */
describe("an encrypted note", () => {
  /** The shape `apps/mcp/src/encryption.js` writes, abbreviated. */
  const ENVELOPE = [
    "---",
    "context_encryption: v1",
    "context_encryption_key: ws:k1",
    "---",
    "",
    "> [!NOTE] This note is encrypted.",
    "",
    "```context-encrypted",
    '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA","aad":"context-note-v1:ws_x","recipients":[]}',
    "```",
    "",
  ].join("\n");

  test("reads as locked, and readOnly is forced whether or not the client knows the flag", async () => {
    const store = bucket();
    store.seed("1-projects/secret.md", ENVELOPE);

    const file = await readFile(store, { path: "1-projects/secret.md", clearance: clearanceOf("private") });
    expect(file.encrypted).toBe(true);
    // The older console never heard of `encrypted`. It honours `readOnly`, which
    // is why the protection rides on the field that already existed and the new
    // one only carries the explanation.
    expect(file.readOnly).toBe(true);
    // The ciphertext is returned rather than withheld: it is what is in the
    // bucket, the caller has passed `canSee`, and the file says in its own plain
    // frontmatter what it is.
    expect(file.text).toBe(ENVELOPE);
  });

  test("an ordinary note is not locked, so the flag is not always true", async () => {
    const store = bucket();
    const file = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    expect(file.encrypted).toBe(false);
    expect(file.readOnly).toBe(false);
  });

  test("cannot be overwritten through this path, even with the right etag", async () => {
    const store = bucket();
    store.seed("1-projects/secret.md", ENVELOPE);
    const file = await readFile(store, { path: "1-projects/secret.md", clearance: clearanceOf("private") });

    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/secret.md",
        text: "# I am plaintext now\n",
        expectedEtag: file.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
    // The bytes, which is the claim that matters. A code with a write behind it
    // is worse than no code at all.
    expect(store.snapshot()["1-projects/secret.md"]).toBe(ENVELOPE);
  });

  test("...and the refusal is not a conflict, because reloading cannot help", async () => {
    const store = bucket();
    store.seed("1-projects/secret.md", ENVELOPE);

    // A *stale* etag would ordinarily be `CONFLICT`. The encryption check runs
    // first on purpose: telling somebody to reload and try again at a write that
    // can never succeed sends them round a loop with no end.
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/secret.md",
        text: "# I am plaintext now\n",
        expectedEtag: "an-etag-that-was-never-issued",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
  });

  test("a malformed envelope is refused a write too", async () => {
    const store = bucket();
    // Marked encrypted, and unparseable. This is the case where overwriting is
    // least recoverable, so it must be refused at least as hard — which is why
    // the check reads the marker rather than a successful parse.
    store.seed("1-projects/broken.md", "---\ncontext_encryption: v1\n---\n\nnot an envelope\n");
    const refused = await capture(() =>
      writeFile(store, {
        path: "1-projects/broken.md",
        text: "# replaced\n",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("NOTE_ENCRYPTED");
  });

  test("a note that merely writes about the marker is an ordinary note", async () => {
    const store = bucket();
    store.seed(
      "1-projects/about-encryption.md",
      "---\nupdated: 2026-09-07\n---\n\ncontext_encryption: v1 is a frontmatter key.\n",
    );
    const file = await readFile(store, {
      path: "1-projects/about-encryption.md",
      clearance: clearanceOf("private"),
    });
    expect(file.encrypted).toBe(false);
    // And it saves, which is the point: a rule that read the body would let
    // anybody make one of their own notes permanently unsavable by describing
    // this feature in it.
    const written = await writeFile(store, {
      path: "1-projects/about-encryption.md",
      text: "# rewritten\n",
      expectedEtag: file.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(written.path).toBe("1-projects/about-encryption.md");
  });

  test("a team caller is refused a private encrypted note exactly as it is refused a missing one", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/vault.md", ENVELOPE);

    const hidden = await capture(() => readFile(store, { path: "2-areas/vault.md", clearance: clearanceOf("team") }));
    const missing = await capture(() =>
      readFile(store, { path: "2-areas/no-such-note.md", clearance: clearanceOf("team") }),
    );
    // Byte-for-byte, in the style of `isolation.test.ts`: encrypting a note must
    // add no way to tell it apart from a path that never existed.
    expect(errorShape(hidden)).toBe(errorShape(missing));
  });
});
