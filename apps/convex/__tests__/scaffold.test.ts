/**
 * Scaffolding a new context.
 *
 * Two things must hold, and the second one matters more than the first:
 *
 *  1. A fresh bucket comes out with a layout the **gateway** can read — proved
 *     against the gateway's real `privacy.md` parser, not against a copy of
 *     what we think it wants.
 *  2. A bucket that already holds someone's context comes out **byte-identical**.
 *     Connecting an existing brain is the primary case, not the edge case: the
 *     founder's own bucket has been live since August, is synced to Obsidian,
 *     and must connect with nothing changed and nothing migrated.
 */

import { describe, expect, test } from "vitest";
import { S3Store } from "../../mcp/src/store/s3.js";
import {
  DETECT_PAGE_CAP,
  DETECT_PAGE_SIZE,
  INDEX_KEY,
  MAX_CUSTOM_FOLDERS,
  MAX_FOLDER_DESCRIPTION_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  PARA_FOLDERS,
  PRIVACY_KEY,
  type ScaffoldStore,
  hasExistingContext,
  hasForeignContent,
  renderPrivacyManifest,
  renderPrivacyManifestForFolders,
  scaffoldContext,
  validateCustomFolders,
} from "../functions/lib/scaffold";
import { gatewayInternals } from "./gatewayFormat.helpers";
import { memoryS3, memoryStore } from "./storeStub.helpers";

const FAKE_BUCKET = "example-context-bucket";
const FAKE_S3 = {
  endpoint: "https://accountid.r2.cloudflarestorage.example/",
  region: "auto",
  bucket: FAKE_BUCKET,
  accessKeyId: "EXAMPLEACCESSKEYID00",
  secretAccessKey: "example-secret-access-key-not-real-000000",
};

describe("a fresh bucket", () => {
  test("gets the PARA folders, an index, and a privacy manifest", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "created" });
    expect(result.written.sort()).toEqual(
      [
        "0-inbox/README.md",
        "1-projects/README.md",
        "2-areas/README.md",
        "3-resources/README.md",
        "4-archive/README.md",
        INDEX_KEY,
        PRIVACY_KEY,
      ].sort(),
    );
  });

  test("writes no key under any namespace — tenancy is the bucket itself", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });

    for (const key of store.objects.keys()) {
      expect(key).not.toMatch(/^tenants\//);
      expect(key).not.toMatch(/^workspaces\//);
      // A note lives at `1-projects/foo.md`, full stop. Every scaffolded key
      // is either at the root or directly inside a PARA folder.
      const [head] = key.split("/");
      expect([...PARA_FOLDERS, INDEX_KEY, PRIVACY_KEY]).toContain(head);
    }
  });

  test("every README explains what belongs in its folder", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });

    for (const folder of PARA_FOLDERS) {
      const body = store.objects.get(`${folder}/README.md`)!.body;
      expect(body.length).toBeGreaterThan(80);
      expect(body).toMatch(/^# /);
    }
  });

  test("is idempotent — a second run writes nothing", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });
    const before = store.snapshot();

    const second = await scaffoldContext(store, { structureTemplate: "para" });
    expect(second).toMatchObject({ scaffolded: false, reason: "existing-context" });
    expect(store.snapshot()).toEqual(before);
  });
});

/**
 * The format contract with `apps/mcp`.
 *
 * These run the gateway's own parser over what we wrote. A change to either
 * side that breaks the other fails here.
 */
describe("the privacy manifest the gateway will read", () => {
  test("parses with the gateway's own parsePrivacyManifest", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });

    const { parsePrivacyManifest } = gatewayInternals();
    const parsed = parsePrivacyManifest(store.objects.get(PRIVACY_KEY)!.body);

    expect(parsed.rules.map((rule) => rule.prefix).sort()).toEqual(
      [...PARA_FOLDERS].sort(),
    );
    expect(parsed.rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(parsed.overrides.size).toBe(0);
  });

  test("a custom manifest parses too, with no folder rules", () => {
    const { parsePrivacyManifest } = gatewayInternals();
    const parsed = parsePrivacyManifest(renderPrivacyManifest("custom"));
    expect(parsed.rules).toEqual([]);
    expect(parsed.overrides.size).toBe(0);
  });

  /**
   * The default is the *safe* direction, and it is worth asserting rather than
   * assuming: `team` is not public, but it is still other people, and a
   * context created five seconds ago has granted nobody anything.
   */
  test("nothing starts visible to anyone but the owner", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    for (const key of [
      "0-inbox/README.md",
      "1-projects/README.md",
      "1-projects/anything.md",
      INDEX_KEY,
      PRIVACY_KEY,
    ]) {
      expect(canSee(key, "team", rules, overrides), `${key} is team-visible`).toBe(
        false,
      );
    }
    // …and the owner sees their own notes, or the scaffold would be pointless.
    expect(canSee("1-projects/anything.md", "private", rules, overrides)).toBe(true);
  });

  test("declares no reserved or plumbing path, which the gateway would reject", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });
    const { isPlumbing } = gatewayInternals();

    for (const key of store.objects.keys()) {
      if (key === PRIVACY_KEY) continue;
      expect(isPlumbing(key), `${key} is plumbing`).toBe(false);
    }
  });
});

describe('structureTemplate "custom"', () => {
  test("writes only the index and the privacy manifest", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, { structureTemplate: "custom" });

    expect(result.written.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    expect([...store.objects.keys()].sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    for (const folder of PARA_FOLDERS) {
      expect(store.objects.has(`${folder}/README.md`)).toBe(false);
    }
  });

  test("says PARA is not imposed, so the index does not claim otherwise", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "custom" });
    const index = store.objects.get(INDEX_KEY)!.body;
    expect(index).not.toContain("1-projects/");
  });
});

/* -------------------------------------------------------------------------- */
/*                          the owner's own folders                           */
/* -------------------------------------------------------------------------- */

/**
 * A folder name here becomes a **key prefix in somebody's own bucket** — one
 * that Obsidian will sync, rclone will mirror, and the gateway will address in
 * a URL. So the validator is the interesting part, and every case below is a
 * *refusal*, never a repair: silently rewriting `../escape` to `escape` gives
 * the person a folder they did not ask for, under a name they will not
 * recognise, somewhere we do not own.
 */
describe("a caller-supplied layout is validated before it becomes a key", () => {
  const OK = { folder: "clients", description: "One folder per client." };

  test("an ordinary layout comes back exactly as supplied", () => {
    const result = validateCustomFolders([
      OK,
      { folder: "reading", description: "  Books worth keeping.  " },
    ]);
    expect(result).toEqual({
      ok: true,
      folders: [
        OK,
        // The description is prose bound for a README body, so surrounding
        // whitespace is trimmed. The *name* is never touched.
        { folder: "reading", description: "Books worth keeping." },
      ],
    });
  });

  /** The hostile set, each with the reason a client can branch on. */
  test.each([
    ["..", "traversal"],
    [".", "traversal"],
    // Caught as a path rather than as traversal — it is one, and either way it
    // is refused. Which reason fires does not matter; that none of them is
    // "accepted, repaired" does.
    ["../../etc", "not-a-single-segment"],
    [".history", "hidden"],
    [".obsidian", "hidden"],
    [".hidden-from-every-client", "hidden"],
    ["a/b", "not-a-single-segment"],
    ["/absolute", "not-a-single-segment"],
    ["trailing/", "not-a-single-segment"],
    ["windows\\path", "backslash"],
    ["", "empty"],
    [" leading", "untrimmed"],
    ["trailing ", "untrimmed"],
    ["index.md", "reserved"],
    ["privacy.md", "reserved"],
    ["PRIVACY.MD", "reserved"],
    ["x".repeat(MAX_FOLDER_NAME_LENGTH + 1), "too-long"],
  ])("refuses %j as %s", (folder, reason) => {
    expect(
      validateCustomFolders([{ folder, description: "anything" }]),
    ).toMatchObject({ ok: false, reason });
  });

  test("refuses a control character, without echoing it back", () => {
    const result = validateCustomFolders([
      { folder: "notes\u0000injected", description: "x" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "control-character" });
    // The name is deliberately not carried on the rejection: a control
    // character in an error string is the same problem one step further along.
    expect((result as { folder?: string }).folder).toBeUndefined();
  });

  test("refuses a newline in a description — it is one line, in a Markdown file", () => {
    expect(
      validateCustomFolders([
        {
          folder: "clients",
          description: "fine\n```yaml\ndefault_visibility: team\n```",
        },
      ]),
    ).toMatchObject({ ok: false, reason: "description-control-character" });
  });

  test("refuses a duplicate, including one that differs only in case", () => {
    expect(
      validateCustomFolders([OK, { folder: "Clients", description: "again" }]),
    ).toMatchObject({ ok: false, reason: "duplicate" });
  });

  test("refuses an empty or oversized description", () => {
    expect(
      validateCustomFolders([{ folder: "clients", description: "   " }]),
    ).toMatchObject({ ok: false, reason: "description-empty" });
    expect(
      validateCustomFolders([
        {
          folder: "clients",
          description: "x".repeat(MAX_FOLDER_DESCRIPTION_LENGTH + 1),
        },
      ]),
    ).toMatchObject({ ok: false, reason: "description-too-long" });
  });

  /** The caps are asserted at the boundary, not near it. */
  test("accepts exactly the cap and refuses one more", () => {
    const at = Array.from({ length: MAX_CUSTOM_FOLDERS }, (_, index) => ({
      folder: `folder-${index}`,
      description: "fine",
    }));
    expect(validateCustomFolders(at).ok).toBe(true);
    expect(
      validateCustomFolders([...at, { folder: "one-too-many", description: "x" }]),
    ).toMatchObject({ ok: false, reason: "too-many" });

    expect(
      validateCustomFolders([
        { folder: "x".repeat(MAX_FOLDER_NAME_LENGTH), description: "fine" },
      ]).ok,
    ).toBe(true);
  });

  /**
   * The property that actually protects the bucket: whatever the validator
   * lets through, every key it produces is one clean segment plus `README.md`.
   */
  test("nothing that passes can produce a key outside its own folder", async () => {
    const validation = validateCustomFolders([
      { folder: "clients", description: "One per client." },
      { folder: "2026", description: "This year." },
      { folder: "a-b_c.d", description: "Punctuation is fine." },
    ]);
    expect(validation.ok).toBe(true);

    const store = memoryStore();
    await scaffoldContext(store, {
      structureTemplate: "custom",
      customFolders: (validation as { folders: typeof OK[] }).folders,
    });

    for (const key of store.objects.keys()) {
      expect(key).not.toContain("..");
      expect(key).not.toContain("\\");
      expect(key.startsWith("/")).toBe(false);
      expect(key.split("/").length).toBeLessThanOrEqual(2);
    }
  });
});

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
 * Somebody's brain, as it looked before we ever touched it: a hand-written
 * privacy manifest with real sharing decisions in it, a hand-written index, and
 * notes. Module-scope because the resume tests further down have to prove this
 * bucket is refused too — a scaffold that can be finished must not become a way
 * into a vault that was here first.
 */
function seedLiveBrain(store: { seed(key: string, body: string): void }): void {
  store.seed(
    PRIVACY_KEY,
    [
      "---",
      "role: privacy-manifest",
      "version: 1",
      "---",
      "",
      "# Brain Privacy Map",
      "",
      "<!-- BEGIN BRAIN PRIVACY RULES -->",
      "",
      "```yaml",
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  1-projects/private: private",
      "  2-areas: team",
      "  2-areas/health: private",
      "  index.md: team",
      "",
      "note_overrides:",
      "  1-projects/secret-plan.md: private",
      "```",
      "",
      "<!-- END BRAIN PRIVACY RULES -->",
      "",
    ].join("\n"),
  );
  store.seed(INDEX_KEY, "# My brain\n\nHand-written manifest.\n");
  store.seed("1-projects/ship-the-thing.md", "# Ship the thing\n");
  store.seed("1-projects/secret-plan.md", "# Secret plan\n");
  store.seed("2-areas/health/notes.md", "# Health\n");
  store.seed("0-inbox/README.md", "my own inbox readme, not yours\n");
  store.seed("4-archive/2024/old.md", "# Old\n");
}

/**
 * An existing brain, connected for the first time.
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
    seedLiveBrain(store);
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
    seedLiveBrain(store);
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
   * A real brain snapshots every overwrite into `.history/`, so it accumulates
   * tens of thousands of objects under a key that sorts *before* every note
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
   * `.history/` subtree — tens of thousands of objects on a real brain, all
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

/* -------------------------------------------------------------------------- */
/*                     a scaffold that only partly lands                      */
/* -------------------------------------------------------------------------- */

const PARA_READMES = PARA_FOLDERS.map((folder) => `${folder}/README.md`);

/**
 * ISSUE #22.
 *
 * A bucket can refuse a write partway through — a policy that denies a prefix,
 * a credential rotated out from under us — and the old code did two wrong
 * things with that. It called the whole run `failed`, when the file that
 * actually matters had landed and the bucket *was* a working context. And it
 * left the owner unable to finish: the retry's first guard saw the `privacy.md`
 * the first attempt wrote, called the bucket an existing context, and told them
 * "nothing has been changed" while their bucket sat half-written. Completing it
 * meant deleting objects by hand over S3.
 *
 * What is essential is decided by the gateway, not by taste: `privacy.md` is
 * the visibility manifest `loadPrivacyState` parses, and without it a context
 * silently runs on the legacy `.note-acl` fallback and cannot have its folder
 * visibility changed at all. `index.md` is read in one guarded place
 * (`toolOrient`) and READMEs in none. See `ESSENTIAL_KEYS`.
 */
describe("essentials are guaranteed; folders and READMEs are best effort", () => {
  test("privacy.md is written before anything best-effort, not after", async () => {
    // A bucket that accepts exactly one object and then starts refusing. What
    // survives is decided entirely by write order.
    let accepted = 0;
    const store = memoryStore({ refuseWrite: () => accepted++ >= 1 });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result.written).toEqual([PRIVACY_KEY]);
    expect(result.reason).toBe("partial");
  });

  test("folders that will not write are a caveat, not a failure", async () => {
    const store = memoryStore({
      refuseWrite: (key) => key.endsWith("/README.md"),
    });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "partial" });
    expect(result.written.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    expect(result.missing.sort()).toEqual([...PARA_READMES].sort());
    // The claim behind calling this a success: the manifest the gateway
    // enforces visibility with is there, and it parses.
    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(store.objects.get(PRIVACY_KEY)!.body).rules,
    ).toHaveLength(PARA_FOLDERS.length);
  });

  test("an essential that will not write is a failure, and stops the run", async () => {
    const store = memoryStore({ refuseWrite: (key) => key === PRIVACY_KEY });

    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: false, reason: "failed" });
    expect(result.missing).toContain(PRIVACY_KEY);
    // Nothing else was laid into a bucket that just refused the access
    // manifest. A folder full of READMEs and no privacy.md is not a context.
    expect([...store.objects.keys()]).toEqual([]);
    expect(result.error).toContain("AccessDenied");
  });

  test("the error never becomes the reason a good scaffold looks bad", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result).toMatchObject({ reason: "created", missing: [] });
    expect(result.error).toBeUndefined();
  });
});

/**
 * FINISHING THE JOB.
 *
 * `resume` narrows the first guard from "is anything here" to "is anything here
 * that we did not write, byte for byte". Every test in this block is either
 * that finishing the job now works, or that the narrowing did not open a door.
 */
describe("a half-written scaffold can be finished", () => {
  /** A partial run, and a switch to let the bucket start accepting writes. */
  async function halfWritten() {
    const refuse = { readmes: true };
    const store = memoryStore({
      refuseWrite: (key) => refuse.readmes && key.endsWith("/README.md"),
    });
    const first = await scaffoldContext(store, { structureTemplate: "para" });
    expect(first.reason).toBe("partial");
    return { store, refuse, first };
  }

  test("a plain retry still refuses — the bucket does look like a context", async () => {
    const { store } = await halfWritten();

    // Not a bug in the detector. From the outside this bucket holds a
    // privacy.md and an index.md, which is exactly what a small context looks
    // like. It is the caller that has to know better.
    expect(await hasExistingContext(store)).toBe(true);
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "existing-context", written: [] });
  });

  test("a resumed retry completes the layout instead of refusing", async () => {
    const { store, refuse } = await halfWritten();
    const privacyBefore = store.objects.get(PRIVACY_KEY)!;
    refuse.readmes = false;

    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });

    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.missing).toEqual([]);
    expect(second.written.sort()).toEqual([...PARA_READMES].sort());
    expect(second.skipped.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    // The files the first attempt landed were skipped, not rewritten: same
    // etag, same bytes. A resume that re-`put` privacy.md would reset any
    // visibility the owner had already changed.
    expect(store.objects.get(PRIVACY_KEY)).toBe(privacyBefore);
    expect([...store.objects.keys()].sort()).toEqual(
      [...PARA_READMES, INDEX_KEY, PRIVACY_KEY].sort(),
    );
  });

  test("resuming twice is still idempotent", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    await scaffoldContext(store, { structureTemplate: "para", resume: true });
    const before = store.snapshot();

    const third = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });
    expect(third).toMatchObject({ scaffolded: false, reason: "created" });
    expect(store.snapshot()).toEqual(before);
  });

  /**
   * THE GUARD THAT HAS TO SURVIVE.
   *
   * Resume is a licence to write into a bucket that is not empty. If it ever
   * applied to somebody's live vault it would be the exact bug the whole module
   * exists to prevent, so the licence is checked against the bucket itself,
   * not only against the row that granted it.
   */
  test("a vault that was here before we arrived is refused, resume or not", async () => {
    const store = memoryStore();
    seedLiveBrain(store);
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ scaffolded: false, reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("one note of theirs beside our half-written layout is enough to refuse", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    // Inside a folder our own layout owns, which is the case a root-only check
    // would wave through: `1-projects/` is a prefix we would have written.
    store.seed("1-projects/their-note.md", "# Mine, thanks\n");
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("a file at one of our keys that we did not write is enough to refuse", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    // Same key, different bytes. Byte-identity is what makes the answer "we
    // wrote this" rather than "something with this name is here".
    store.seed(PRIVACY_KEY, "# hand written, do not touch\n");
    const before = store.snapshot();

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "existing-context", written: [] });
    expect(store.snapshot()).toEqual(before);
  });

  test("resuming with a different layout than the one we started is refused", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;

    // The half-written PARA files are not keys a custom layout would write, so
    // they read as foreign — which is the right answer. Two interleaved
    // layouts in somebody's bucket is not a repair.
    expect(
      await scaffoldContext(store, {
        structureTemplate: "custom",
        customFolders: [{ folder: "clients", description: "One per client." }],
        resume: true,
      }),
    ).toMatchObject({ reason: "existing-context", written: [] });
  });

  test("plumbing beside a half-written layout is not foreign", async () => {
    const { store, refuse } = await halfWritten();
    refuse.readmes = false;
    store.seed(".history/privacy.md.1", "an earlier version");
    store.seed(".context-probe/probe", "left by verification");

    expect(
      await scaffoldContext(store, { structureTemplate: "para", resume: true }),
    ).toMatchObject({ reason: "created" });
  });

  test("resume finishes a run whose essential failed, once the bucket lets it", async () => {
    const refuse = { all: true };
    const store = memoryStore({ refuseWrite: () => refuse.all });
    expect(
      await scaffoldContext(store, { structureTemplate: "para" }),
    ).toMatchObject({ reason: "failed", scaffolded: false });

    refuse.all = false;
    const second = await scaffoldContext(store, {
      structureTemplate: "para",
      resume: true,
    });
    expect(second).toMatchObject({ scaffolded: true, reason: "created" });
    expect(second.written.sort()).toEqual(
      [...PARA_READMES, INDEX_KEY, PRIVACY_KEY].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                    the same thing, through the real adapter                */
/* -------------------------------------------------------------------------- */

/**
 * Everything above runs against a hand-written `ContextStore`. That proves the
 * scaffolding logic and nothing about the adapter the control plane actually
 * builds — so run it once more through the real `S3Store`, with real SigV4,
 * real key encoding, real XML listing, over a fetch stub speaking S3.
 */
describe("through the real S3 adapter", () => {
  test("scaffolds a fresh bucket end to end", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    const store = new S3Store({
      ...FAKE_S3,
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    const result = await scaffoldContext(store, { structureTemplate: "para" });
    expect(result.scaffolded).toBe(true);
    expect([...backend.objects.keys()].sort()).toEqual(result.written.sort());

    const { parsePrivacyManifest } = gatewayInternals();
    expect(
      parsePrivacyManifest(backend.objects.get(PRIVACY_KEY)!.body).rules,
    ).toHaveLength(PARA_FOLDERS.length);
  });

  test("leaves an existing bucket alone end to end", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    backend.seed("1-projects/live.md", "# Live\n");
    backend.seed(PRIVACY_KEY, "# hand written\n");
    const before = backend.snapshot();

    const store = new S3Store({
      ...FAKE_S3,
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    expect(await scaffoldContext(store, { structureTemplate: "para" })).toMatchObject(
      { scaffolded: false, reason: "existing-context" },
    );
    expect(backend.snapshot()).toEqual(before);
    // Not one write was attempted.
    expect(backend.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  /**
   * A customer whose bucket holds other things can point us at a subtree. That
   * prefix is applied inside the adapter and is invisible to the scaffolder —
   * and it is emphatically not tenancy: it is the customer's own choice, never
   * derived from a workspace id.
   */
  test("honours a customer-chosen rootPrefix without the scaffolder knowing", async () => {
    const backend = memoryS3(FAKE_BUCKET);
    const store = new S3Store({
      ...FAKE_S3,
      rootPrefix: "notes/brain/",
      fetchImpl: backend.fetchImpl,
    }) as unknown as ScaffoldStore;

    const result = await scaffoldContext(store, { structureTemplate: "custom" });

    // The scaffolder asked for `index.md`…
    expect(result.written.sort()).toEqual([INDEX_KEY, PRIVACY_KEY].sort());
    // …and the bucket got `notes/brain/index.md`.
    expect([...backend.objects.keys()].sort()).toEqual(
      ["notes/brain/index.md", "notes/brain/privacy.md"].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                          a shared workspace                                */
/* -------------------------------------------------------------------------- */

/**
 * The one thing `kind` changes, and the reason it had to change something.
 *
 * A workspace exists because several people are in it. Scaffolded all-private —
 * which is what happened before this — every folder is unreachable to everybody
 * but an owner, because `clampScopes` lets only an `owner` hand a client the
 * `context:private` scope. So an `editor` invited into a brand-new workspace
 * could not read one note in it by any grant they were able to issue, and the
 * fix was a file they had to know existed.
 *
 * These are written against the **gateway's own** parser and `canSee`, for the
 * reason `gatewayFormat.helpers.ts` gives: an assertion about the bytes we
 * wrote would be both halves of our own expectation.
 */
describe("a shared workspace's starting manifest", () => {
  test("opens the scaffolded folders to the workspace, and only those", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual([...PARA_FOLDERS].sort());
    expect(rules.every((rule) => rule.vis === "team")).toBe(true);
    expect(overrides.size).toBe(0);

    for (const key of [
      "0-inbox/README.md",
      "1-projects/README.md",
      "1-projects/anything.md",
      "4-archive/deep/nested/note.md",
    ]) {
      expect(canSee(key, "team", rules, overrides), `${key} is not readable`).toBe(
        true,
      );
    }
  });

  /**
   * `default_visibility` stays `private` — it is fixed in
   * `renderPrivacyRulesBlock` — so opening the five folders the scaffolder made
   * is not the same as opening the bucket. A folder somebody adds later is
   * still private until a line names it, which is the property that keeps this
   * a starting layout rather than a switch.
   */
  test("a path outside the declared folders still fails closed", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(canSee("payroll/salaries.md", "team", rules, overrides)).toBe(false);
    expect(canSee("root-level-note.md", "team", rules, overrides)).toBe(false);
  });

  /** `privacy.md` is the access map. Reading it is an owner's business either way. */
  test("the access map itself is never team-readable", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );
    expect(canSee(PRIVACY_KEY, "team", rules, overrides)).toBe(false);
  });

  test("a custom layout opens the owner's own folders, not PARA's", async () => {
    const store = memoryStore();
    await scaffoldContext(store, {
      structureTemplate: "custom",
      kind: "shared",
      customFolders: [
        { folder: "handbook", description: "How we work." },
        { folder: "customers", description: "One folder per account." },
      ],
    });

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(
      store.objects.get(PRIVACY_KEY)!.body,
    );

    expect(rules.map((rule) => rule.prefix).sort()).toEqual(["customers", "handbook"]);
    expect(canSee("handbook/onboarding.md", "team", rules, overrides)).toBe(true);
    expect(canSee("1-projects/anything.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * The regression that matters most. A personal brain is the majority case and
   * the one where a `team` default would hand somebody's notes to whoever they
   * later invite, without being asked. Sabotage `startingVisibility`'s
   * `personal` branch and this is what fails.
   */
  test("a personal brain is untouched by any of this", async () => {
    const shared = memoryStore();
    const personal = memoryStore();
    const omitted = memoryStore();
    await scaffoldContext(shared, { structureTemplate: "para", kind: "shared" });
    await scaffoldContext(personal, { structureTemplate: "para", kind: "personal" });
    // No `kind` at all: the conservative branch, for a job scheduled by an
    // older mutation during a rollout.
    await scaffoldContext(omitted, { structureTemplate: "para" });

    const personalManifest = personal.objects.get(PRIVACY_KEY)!.body;
    expect(omitted.objects.get(PRIVACY_KEY)!.body).toBe(personalManifest);
    expect(shared.objects.get(PRIVACY_KEY)!.body).not.toBe(personalManifest);

    const { parsePrivacyManifest, canSee } = gatewayInternals();
    const { rules, overrides } = parsePrivacyManifest(personalManifest);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(canSee("1-projects/anything.md", "team", rules, overrides)).toBe(false);
  });

  /**
   * `resetPrivacyManifest` repairs a manifest that was failing closed, against
   * a bucket that already has members and content — neither property a fresh
   * workspace has. All-private is the only rewrite there under which nothing
   * changes hands, so the repair renderer must keep defaulting to it.
   */
  test("the repair renderer still writes an all-private manifest", () => {
    const { parsePrivacyManifest } = gatewayInternals();
    const { rules } = parsePrivacyManifest(
      renderPrivacyManifestForFolders(["1-projects", "handbook"]),
    );
    expect(rules.length).toBe(2);
    expect(rules.every((rule) => rule.vis === "private")).toBe(true);
  });

  test("the manifest tells a member what the two words mean here", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para", kind: "shared" });
    const manifest = store.objects.get(PRIVACY_KEY)!.body;

    // The one thing a member cannot discover by reading the rules: `private`
    // in a workspace is not "the person who wrote it", it is "owners".
    expect(manifest).toContain("owners");
    expect(manifest).toContain("every member of this workspace");
    expect(manifest).not.toContain("only you");
  });
});
