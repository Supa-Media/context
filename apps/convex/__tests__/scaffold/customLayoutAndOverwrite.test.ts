import { describe, expect, test } from "vitest";
import {
  DETECT_PAGE_CAP,
  DETECT_PAGE_SIZE,
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
  type ScaffoldStore,
  hasExistingContext,
  hasForeignContent,
  scaffoldContext,
} from "../../functions/lib/scaffold";
import { gatewayInternals } from "../gatewayFormat.helpers";
import { memoryStore } from "../storeStub.helpers";
import {
  seedLiveWorkspace,
} from "./fixtures";

describe("a custom layout is written in the owner's own words", () => {
  const FOLDERS = [
    { folder: "clients", description: "One folder per client." },
    { folder: "reading", description: "Books and articles worth keeping." },
  ];

  test("each folder gets a README carrying its description, verbatim", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, {
      structureTemplate: "custom",
      customFolders: FOLDERS,
    });

    expect(result.written.sort()).toEqual(
      ["clients/README.md", "reading/README.md", INDEX_KEY, PRIVACY_KEY].sort(),
    );
    expect(store.objects.get("clients/README.md")!.body).toContain(
      "One folder per client.",
    );
    // None of PARA's folders appear — they chose otherwise.
    for (const folder of PARA_FOLDERS) {
      expect(store.objects.has(`${folder}/README.md`)).toBe(false);
    }
  });

  test("the manifest lists their folders and their descriptions", async () => {
    const store = memoryStore();
    await scaffoldContext(store, {
      structureTemplate: "custom",
      customFolders: FOLDERS,
    });

    const index = store.objects.get(INDEX_KEY)!.body;
    expect(index).toContain("`clients/` — One folder per client.");
    expect(index).toContain("`reading/` — Books and articles worth keeping.");
    expect(index).not.toContain("1-projects/");
  });

  /**
   * The recommendation the product owner signed off on: **every folder
   * private, no exceptions.** `team` grants nothing today, because a
   * five-minute-old context has no collaborators — but the moment its owner
   * invites somebody, a folder that defaulted to `team` becomes visible
   * without anyone having decided that. A default that only becomes
   * consequential later, silently, is the wrong default.
   */
  test("every folder they named starts private, read back through the gateway", async () => {
    const store = memoryStore();
    await scaffoldContext(store, {
      structureTemplate: "custom",
      customFolders: FOLDERS,
    });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual([
      "clients",
      "reading",
    ]);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
    for (const key of ["clients/acme.md", "reading/a-book.md", INDEX_KEY]) {
      expect(canSee(key, "team", rules, overrides), `${key} is team-visible`).toBe(
        false,
      );
    }
  });

  test("a custom layout never overwrites an existing context either", async () => {
    const store = memoryStore();
    store.seed("clients/acme.md", "# Acme\n");
    store.seed("clients/README.md", "my own words, not yours\n");
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, {
        structureTemplate: "custom",
        customFolders: FOLDERS,
      }),
    ).toMatchObject({ scaffolded: false, reason: "existing-context" });
    expect(store.snapshot()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/*                        the case that actually matters                      */
/* -------------------------------------------------------------------------- */


/**
 * An existing workspace, connected for the first time.
 *
 * "Nothing changes" is asserted as *byte-identical*, not as "we did not crash":
 * the failure mode this guards against is a scaffold that quietly replaces a
 * hand-curated `index.md`, or — far worse — replaces `privacy.md` and resets
 * every folder that was shared back to private, or every private folder to
 * whatever our defaults happen to say.
 */
describe("an existing context is never overwritten", () => {
  test("every existing object is byte-identical afterwards", async () => {
    const store = memoryStore();
    seedLiveWorkspace(store);
    const before = store.snapshot();

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({
      scaffolded: false,
      reason: "existing-context",
      written: [],
    });
    expect(store.snapshot()).toEqual(before);
  });

  test("the owner's privacy rules survive exactly, read back through the gateway", async () => {
    const store = memoryStore();
    seedLiveWorkspace(store);
    await scaffoldContext(store, { structureTemplate: "para" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    // Still shared…
    expect(canSee("1-projects/ship-the-thing.md", "team", rules, overrides)).toBe(true);
    // …and still not.
    expect(canSee("2-areas/health/notes.md", "team", rules, overrides)).toBe(false);
    expect(canSee("1-projects/secret-plan.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * The regression this design exists for.
   *
   * A workspace connected before snapshots stopped accumulated one object per
   * overwrite under a key that sorts *before* every note — tens of thousands
   * (`.` is 0x2E, `0` is 0x30). A flat first-page listing of that bucket comes
   * back looking completely empty, and a detector built on one would scaffold
   * straight over a live context. Listing with a delimiter collapses the whole
   * subtree to one prefix.
   */
  test("is not fooled by a bucket whose first pages are all .history plumbing", async () => {
    const store = memoryStore();
    // MORE PLUMBING THAN A FLAT WALK COULD EVER GET PAST, and that arithmetic
    // is the whole test. `hasExistingContext` walks at most
    // `DETECT_PAGE_CAP * DETECT_PAGE_SIZE` entries; seed fewer `.history`
    // objects than that and a flat listing reaches the real note on some later
    // page, so the test passes without the delimiter doing anything. Derived
    // from the constants rather than hardcoded, so raising the cap cannot
    // quietly make this vacuous again.
    const plumbing = DETECT_PAGE_CAP * DETECT_PAGE_SIZE + 100;
    for (let index = 0; index < plumbing; index += 1) {
      store.seed(`.history/1-projects/note.${index}.md`, "old version");
    }
    store.seed("1-projects/note.md", "# Note\n");
    const before = store.snapshot();

    expect(await hasExistingContext(store)).toBe(true);
    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result.reason).toBe("existing-context");
    expect(store.snapshot()).toEqual(before);
  });

  /**
   * The mechanism, asserted directly.
   *
   * The volume test above proves the *outcome*; this proves the reason for it,
   * so a future refactor that reaches the same answer by some other means still
   * has to be deliberate about the delimiter. With a flat listing, the whole
   * `.history/` subtree — tens of thousands of objects on a real workspace, all
   * sorting before every digit and letter — is what comes back.
   */
  test("lists the root with a delimiter, so a subtree collapses to one prefix", async () => {
    const store = memoryStore();
    store.seed("1-projects/note.md", "# Note\n");
    const seen: (string | undefined)[] = [];
    const recording = {
      ...store,
      list: async (options?: { delimiter?: string }) => {
        seen.push(options?.delimiter);
        return await store.list(options);
      },
    } as unknown as ScaffoldStore;

    expect(await hasExistingContext(recording)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((delimiter) => delimiter === "/")).toBe(true);
  });

  test("a bucket holding only plumbing is still fresh", async () => {
    const store = memoryStore();
    store.seed(".obsidian/app.json", "{}");
    store.seed(".history/old.md", "x");

    expect(await hasExistingContext(store)).toBe(false);
    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result.scaffolded).toBe(true);
    // The plumbing it found is exactly as it was.
    expect(store.objects.get(".obsidian/app.json")!.body).toBe("{}");
  });

  test("a bucket holding only privacy.md is an existing context", async () => {
    const store = memoryStore();
    store.seed(PRIVACY_KEY, "# hand written, not even parseable\n");
    const before = store.snapshot();

    expect(await scaffoldContext(store, { structureTemplate: "para" })).toMatchObject({
      scaffolded: false,
      reason: "existing-context",
    });
    expect(store.snapshot()).toEqual(before);
  });

  /**
   * A store that reports another page and offers nowhere to go.
   *
   * `truncated` and `cursor` come from two independent tags — `readTag` in
   * `apps/mcp/src/store/s3.js` reads `IsTruncated` from one element and
   * `NextContinuationToken` from another, with no cross-check — so
   * `{ truncated: true, cursor: undefined }` reaches both detectors. Folded into
   * one `||` with a finished listing, the walk ended and answered **false**,
   * which for these two is the fail-open direction: "no context here, scaffold
   * away" and "nothing foreign here". A walk that did not finish knows nothing,
   * and the only answer it may give is the refusing one.
   *
   * The page cap fell out the same way, and that is fixed here too.
   */
  test("a listing that could not finish is read as occupied, not as empty", async () => {
    // The bucket holds ONLY plumbing, so the delimited root page collapses to
    // `.history/` and the detector reaches the pagination check rather than
    // returning `true` on the first non-plumbing entry it sees. A bucket with a
    // visible folder proves nothing here: it answers `true` before the walk
    // ever paginates, which is how the first version of this test passed with
    // the fix reverted.
    const store = memoryStore();
    store.seed(".history/1-projects/their-note.md.old.md", "# theirs\n");

    const stalling = {
      ...store,
      list: async (options?: Record<string, unknown>) => ({
        ...(await store.list(options as never)),
        // The real bucket is answered honestly; the store just never admits it
        // is done. Everything the walk *did* see is still returned.
        truncated: true,
        cursor: undefined,
      }),
    } as unknown as ScaffoldStore;

    expect(await hasExistingContext(stalling)).toBe(true);
    // The positive control, on the same bucket: an honest store still reaches
    // the end and reports it empty, so the stall is what changed the answer.
    expect(await hasExistingContext(store as unknown as ScaffoldStore)).toBe(false);

    // And the resume detector, which answers the harder question over the same
    // walk. An empty bucket with a store like this is still "do not touch".
    const empty = memoryStore();
    const emptyStalling = {
      ...empty,
      list: async (options?: Record<string, unknown>) => ({
        ...(await empty.list(options as never)),
        truncated: true,
        cursor: undefined,
      }),
    } as unknown as ScaffoldStore;

    expect(await hasForeignContent(emptyStalling, [])).toBe(true);
    // ...and the scaffold that rides on it does nothing.
    const result = await scaffoldContext(emptyStalling, {
      structureTemplate: "para",
      resume: true,
    });
    expect(result.scaffolded).toBe(false);
    expect(result.reason).toBe("existing-context");
    expect(empty.objects.size).toBe(0);
  });

  /**
   * The page cap, which is the other way a walk stops short.
   *
   * Both detectors used to fall out of the loop into `return false` when the
   * budget ran out — the same fail-open answer, by a route that does not need a
   * misbehaving store at all. The commit that changed it advertised the change
   * and pinned nothing: reverting `return true` to `return false` at the end of
   * either loop passed all 1121 checks.
   *
   * Driven with a store that always hands back a fresh cursor, because that is
   * what exhausting the budget looks like from inside the loop, and it needs no
   * five-thousand-key fixture to produce.
   */
  test("a walk that spends its whole page budget is read as occupied too", async () => {
    const endless = (store: ReturnType<typeof memoryStore>) =>
      ({
        ...store,
        list: async (options?: Record<string, unknown>) => ({
          ...(await store.list(options as never)),
          truncated: true,
          cursor: `c${Math.random()}`,
        }),
      }) as unknown as ScaffoldStore;

    const store = memoryStore();
    store.seed(".history/1-projects/their-note.md.old.md", "# theirs\n");
    expect(await hasExistingContext(endless(store))).toBe(true);

    const empty = memoryStore();
    expect(await hasForeignContent(endless(empty), [])).toBe(true);
    // Nothing was written over the bucket we could not see the end of.
    expect(
      (
        await scaffoldContext(endless(empty), {
          structureTemplate: "para",
          resume: true,
        })
      ).scaffolded,
    ).toBe(false);
    expect(empty.objects.size).toBe(0);
  });

  /**
   * The positive control for the test above: an ordinary store that finishes
   * still answers "empty" for an empty bucket. Without this, making the two
   * detectors return `true` unconditionally would pass.
   */
  test("an honest store still reports an empty bucket as empty", async () => {
    const store = memoryStore();
    expect(await hasExistingContext(store)).toBe(false);
    expect(await hasForeignContent(store, [])).toBe(false);
  });

  /**
   * The second guard, on its own. `hasExistingContext` is a judgement call
   * over a listing; the per-key `get` is not a judgement call at all, and it
   * has to work even if the first guard were wrong.
   */
  test("a stray file at a scaffold key survives even when detection says fresh", async () => {
    const store = memoryStore();
    store.seed("1-projects/README.md", "do not touch me\n");

    // A blind listing: `hasExistingContext` sees an empty bucket and clears
    // the scaffold to run. Only the per-key `get` stands between us and
    // clobbering a real file, which is exactly what is being tested.
    const blind = {
      ...store,
      list: async () => ({
        objects: [],
        delimitedPrefixes: [],
        truncated: false,
      }),
    } as unknown as ScaffoldStore;

    expect(await hasExistingContext(blind)).toBe(false);
    const result = await scaffoldContext(blind, { structureTemplate: "para" });

    expect(result.skipped).toEqual(["1-projects/README.md"]);
    expect(store.objects.get("1-projects/README.md")!.body).toBe(
      "do not touch me\n",
    );
    expect(result.written).toContain(INDEX_KEY);
  });
});
