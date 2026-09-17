import { describe, expect, test } from "@jest/globals";
import {
  planVaultFiles,
  vaultPlanForStrategy,
  type PickedVaultFile,
} from "../features/onboarding/vaultImport";

/**
 * EVERY REFUSAL IN `insideVault`, ONE AT A TIME.
 *
 * A vault import is the one place in this app where **a list of paths chosen
 * outside it becomes a list of bucket keys**. `planVaultFiles` is the sieve, and
 * `insideVault` is nine separate refusals wearing one function's name — a
 * traversal guard, a dotfile guard, a named-plumbing set, a control-character
 * guard, a root requirement, a junk-file set, a length cap, and the one line
 * that keeps a vault's own `privacy.md` from landing on the workspace's access
 * manifest.
 *
 * Measured before this file, against the whole mobile suite: **only the
 * `privacy.md` line reddened anything.** Every other refusal could be deleted
 * with 327 suites and 6,201 tests green — and two of them cannot be measured
 * individually at all, for the reason the next section gives.
 *
 * ## Three guards, and one of them does all the work
 *
 * `vaultImport.test.ts` has a test called *"refuses paths that escape the
 * vault"*. Delete the `..` refusal and **it still passes** — because `".."`
 * starts with a dot, so the *dotfile* guard catches it. Delete the dotfile
 * guard instead and it still passes, because `HIDDEN_ROOTS` names the cases
 * that fixture uses.
 *
 * Measuring it one guard at a time says something sharper than "they mask each
 * other", which is what it looks like from the fixture. **`startsWith(".")`
 * strictly subsumes both of the others**: every `.`/`..` segment starts with a
 * dot, and every member of `HIDDEN_ROOTS` starts with a dot. So those two
 * **cannot be isolated by any input at all** while the dotfile rule stands, and
 * their sabotage rows below are **0 and have to stay 0** — the honest kind,
 * like the reachability effect's second read.
 *
 * The dotfile rule itself *can* be isolated, and was not: `.secrets/`,
 * `.hidden.md` and `..x/` are dotted, are not traversal, and are not named in
 * `HIDDEN_ROOTS`. Those inputs are new here, and they are what turns "three
 * overlapping guards, one fixture" into one guard that is actually held.
 *
 * ## What is NOT at stake, because it sets the ceiling
 *
 * **None of this is a live hole and none of it reaches another tenant.** Every
 * guard is present; the storage adapter re-validates each key with
 * `assertSafeKey`/`assertSafePrefix` at the boundary, so a traversal or
 * control-character key that got past this sieve would be refused on the way
 * into the bucket, and tenancy is bucket-level besides. This sieve is the
 * *client* half: it decides what is refused **politely and counted as
 * `skipped`** rather than failing somewhere deeper, and it is the only thing
 * standing between a picked folder and the two paths the product treats as
 * structure rather than content — `privacy.md` and anything under `.context/`.
 *
 * That second one is why this is worth an hour: the on-bucket layout is a
 * versioned stable format, and `.context/` is Context-owned plumbing. An
 * imported `.context/…` file is not a disclosure, it is a write into the
 * product's own storage contract.
 *
 * ## Measured by sabotage, against the whole mobile suite
 *
 * | break | reddens |
 * | --- | --- |
 * | accept a path with no vault-root segment | **1** |
 * | drop the dotfile refusal (`HIDDEN_ROOTS` still present) | **1** |
 * | drop the control-character refusal | **1** |
 * | drop the `.DS_Store` / `Thumbs.db` refusal | **1** |
 * | drop the 1,024-character cap | **1** |
 * | match `privacy.md` case-sensitively only | **1** |
 * | stop normalising backslashes to `/` | **1** |
 * | drop the `.` / `..` refusal | **0 — and it stays 0** |
 * | drop `HIDDEN_ROOTS` | **0 — and it stays 0** |
 *
 * **Every row above the line was 0 before this file**, measured against the
 * whole mobile suite rather than against the vault files alone: the four
 * traversal-and-hidden guards removed together left 2 tests red, and the root
 * requirement and control-character guard removed together left **327 suites
 * and 6,201 tests green**.
 *
 * The two zeros are kept and labelled rather than deleted, for the reason the
 * subsumption paragraph gives. They are not dead: they are the guards that
 * would still be standing if somebody relaxed the dotfile rule — which is a
 * plausible request, since Obsidian keeps real user configuration in
 * `.obsidian/`. `HIDDEN_ROOTS` is the line that would then still refuse
 * `.context/`, and `.context/` is the product's own storage contract.
 *
 * **A predicted table is not a measured one**: the first draft of this header
 * put both of those rows at **1**, because "give each guard an input only it
 * refuses" sounded achievable until it was tried. For a subset relationship it
 * is not achievable at all, and the number is what says so.
 */

const file = (path: string, size = 10): PickedVaultFile => ({
  path,
  size,
  type: "",
  read: async () => new ArrayBuffer(0),
});

/** The paths that survived the sieve, which are the keys that would be written. */
const planned = (...paths: string[]): string[] =>
  planVaultFiles(paths.map((path) => file(path))).files.map((entry) => entry.path);

const skipped = (...paths: string[]): number =>
  planVaultFiles(paths.map((path) => file(path))).skipped;

describe("what a picked folder is allowed to become a bucket key", () => {
  test("an ordinary note keeps its path inside the vault, and loses the vault's own name", () => {
    // The anchor for everything below: the selected folder is segment one and
    // is dropped, because the destination is chosen by the strategy rather than
    // by what the folder happened to be called.
    expect(planned("MyVault/1-projects/plan.md")).toEqual(["1-projects/plan.md"]);
  });

  test("A PATH WITH NO VAULT ROOT IS REFUSED, NOT WRITTEN AT THE TOP LEVEL", () => {
    /*
      `vaultPicker.web.ts` builds each path as `file.webkitRelativePath ||
      file.name`, so a browser that does not preserve the directory relationship
      hands back a **bare filename**. The comment here calls that out — *"A
      picker that cannot preserve that relationship is not safe for a vault
      import"* — because a bare name has nothing to strip, and every file in the
      selection would land at the root of the bucket rather than under the
      folder somebody picked.

      Note the shape of this one: the *obvious* sabotage (`segments.length < 1`)
      is a **no-op**, because a one-segment path yields an empty remainder and
      falls out of the final length check anyway. The guard only stops
      mattering if the remainder falls back to the whole path, which is what a
      "simplification" would do.
    */
    expect(planned("note.md")).toEqual([]);
    expect(skipped("note.md")).toBe(1);
  });

  test("traversal is refused, by whichever of the two guards gets there first", () => {
    /*
      **This test cannot tell you which guard did it, and that is the finding
      rather than a weakness of the test.** `".."` satisfies both the traversal
      refusal and the dotfile refusal, and since every `.`/`..` segment starts
      with a dot there is no input in the language that isolates the first from
      the second. The traversal guard's sabotage row is 0 for that reason and
      stays 0.

      The reverse direction is not symmetric, and the next test is where the
      measurement actually moves: `..x/` and `.secrets/` are dotted, are not
      traversal, and are not in `HIDDEN_ROOTS`.
    */
    expect(planned("MyVault/1-projects/../plan.md")).toEqual([]);
    expect(planned("MyVault/./plan.md")).toEqual([]);
    // Deeper, and with a legitimate-looking prefix, because a guard that only
    // checked the first segment would pass this.
    expect(planned("MyVault/a/b/../../../../etc/passwd")).toEqual([]);
  });

  test("and an ORDINARY dotted segment is refused, which `HIDDEN_ROOTS` does not name", () => {
    // The other half of the pair: none of these is `.` or `..`, and none is in
    // `HIDDEN_ROOTS`, so only the `startsWith(".")` rule refuses them.
    expect(planned("MyVault/.secrets/keys.md")).toEqual([]);
    expect(planned("MyVault/notes/.hidden.md")).toEqual([]);
    expect(planned("MyVault/..x/plan.md")).toEqual([]);
  });

  test("and the named plumbing folders are refused by name as well", () => {
    /*
      `HIDDEN_ROOTS` is redundant with the dotfile rule **today**, and it is
      kept because the two answer different questions: one is "hidden files are
      not content", the other is "`.context` and `.audit` are OUR storage
      contract". A relaxation of the first — somebody wanting `.obsidian`
      snippets imported, say — must not silently reopen the second.

      Asserted through the public function with the dotfile rule live, so this
      documents the set's membership rather than proving it load-bearing. The
      table in the header records that either guard alone still refuses these.
    */
    for (const root of [".obsidian", ".trash", ".git", ".context", ".audit"]) {
      expect(planned(`MyVault/${root}/whatever.md`)).toEqual([]);
    }
  });

  test("a control character never reaches a bucket key", () => {
    /*
      The gateway refuses these too — `normalizePath` and `assertSafeKey` both
      do — so this is the polite half of a boundary that is enforced twice.
      Refused here means "skipped and counted"; refused there means a failed
      write partway through an import.

      **Built with `String.fromCharCode`, not written as an escape.** A raw NUL
      in a tracked file makes git call it binary and the diff disappears, which
      is what `No tracked source file carries a NUL` exists to stop — and that
      job caught this very file on its first push, because the tool that wrote
      it resolved a `\u0000` escape into the byte itself. Constructing the
      character at runtime is the form nothing can silently convert.
    */
    const control = (code: number) => String.fromCharCode(code);
    expect(planned(`MyVault/1-projects/pl${control(0)}an.md`)).toEqual([]);
    expect(planned(`MyVault/1-projects/pl${control(31)}an.md`)).toEqual([]);
    expect(planned(`MyVault/note${control(127)}.md`)).toEqual([]);
  });

  test("the editor's own junk files are not somebody's notes", () => {
    expect(planned("MyVault/.DS_Store")).toEqual([]);
    expect(planned("MyVault/notes/Thumbs.db")).toEqual([]);
    // And the name is only junk in the final position — a folder that happens
    // to be called that still carries its contents.
    expect(planned("MyVault/Thumbs.db/real.md")).toEqual(["Thumbs.db/real.md"]);
  });

  test("an absurdly long key is refused rather than sent", () => {
    const long = `MyVault/${"a".repeat(1_020)}/plan.md`;
    expect(planned(long)).toEqual([]);
    // And the boundary is a boundary: one character under the cap is accepted,
    // so this asserts the limit rather than "long paths fail somehow".
    const atCap = `MyVault/${"a".repeat(1_024)}`;
    expect(planned(atCap)).toEqual(["a".repeat(1_024)]);
  });

  test("A VAULT'S OWN privacy.md NEVER LANDS ON THE WORKSPACE'S ACCESS MANIFEST", () => {
    /*
      The one guard that was already held, and the one with the largest
      consequence: `privacy.md` is not a note, it is the manifest that decides
      who can see what. An imported file overwriting it would rewrite a
      workspace's visibility from a folder somebody dragged in.

      **The case-insensitive comparison is the part that was not held.** A vault
      authored on macOS or Windows can easily contain `Privacy.md`, and the
      guard lowercases for exactly that reason.
    */
    expect(planned("MyVault/privacy.md")).toEqual([]);
    expect(planned("MyVault/Privacy.md")).toEqual([]);
    expect(planned("MyVault/PRIVACY.MD")).toEqual([]);

    // And only at the root, because a note genuinely called `privacy.md` inside
    // a folder is a note. The guard compares the whole joined path, not a
    // basename, and that distinction is deliberate.
    expect(planned("MyVault/1-projects/privacy.md")).toEqual(["1-projects/privacy.md"]);
  });

  test("a Windows path is normalised before any of the above is decided", () => {
    // Every refusal above splits on `/`. A backslash path that skipped
    // normalisation would arrive as ONE segment, be refused as rootless, and
    // the whole vault would import as nothing — or, with the root requirement
    // relaxed, as a single key containing backslashes.
    expect(planned("MyVault\\1-projects\\plan.md")).toEqual(["1-projects/plan.md"]);
    // And normalisation happens FIRST, so traversal written the Windows way is
    // still traversal rather than a literal segment named `..`.
    expect(planned("MyVault\\1-projects\\..\\plan.md")).toEqual([]);
  });

  test("the destination prefix is applied over an already-sieved path", () => {
    // `folder` is the strategy that does not write at the bucket root, and the
    // prefix is built from the vault's own name — so the sieve has to have run
    // first, or the name would carry whatever the folder was called.
    const plan = planVaultFiles([file("MyVault/1-projects/plan.md")]);
    expect(vaultPlanForStrategy(plan, "folder").files.map((entry) => entry.path)).toEqual([
      "Imports/MyVault/1-projects/plan.md",
    ]);
    // `merge` keeps the source path, which is what makes the refusals above the
    // only thing between a picked folder and the root of somebody's bucket.
    expect(vaultPlanForStrategy(plan, "merge").files.map((entry) => entry.path)).toEqual([
      "1-projects/plan.md",
    ]);
  });
});
