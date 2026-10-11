import { describe, expect, test } from "vitest";
import {
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
  MAX_CUSTOM_FOLDERS,
  MAX_FOLDER_DESCRIPTION_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  hasForeignContent,
  renderPrivacyManifest,
  scaffoldContext,
  scaffoldFiles,
  validateCustomFolders,
} from "../../functions/lib/scaffold";
import { gatewayInternals } from "../gatewayFormat.helpers";
import { memoryStore } from "../storeStub.helpers";

describe("a fresh bucket", () => {
  test("gets the PARA folders, an index, and a privacy manifest", async () => {
    const store = memoryStore();
    const result = await scaffoldContext(store, { structureTemplate: "para" });

    expect(result).toMatchObject({ scaffolded: true, reason: "created" });
    expect(result.written.sort()).toEqual(
      [
        "0-inbox/about.md",
        "1-projects/about.md",
        "2-areas/about.md",
        "3-resources/about.md",
        "9-archive/about.md",
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

  test("every about.md explains what belongs in its folder", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });

    for (const folder of PARA_FOLDERS) {
      const body = store.objects.get(`${folder}/about.md`)!.body;
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
      "0-inbox/about.md",
      "1-projects/about.md",
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
      expect(store.objects.has(`${folder}/about.md`)).toBe(false);
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
   * lets through, every key it produces is one clean segment plus `about.md`.
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


describe("folder notes: about.md now, README.md in workspaces scaffolded before", () => {
  test("a fresh layout writes every folder note as about.md, and no README.md", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });
    for (const folder of PARA_FOLDERS) {
      expect(store.objects.has(`${folder}/about.md`), `${folder}/about.md`).toBe(true);
      expect(store.objects.has(`${folder}/README.md`), `${folder}/README.md`).toBe(false);
    }
    expect(store.objects.has(INDEX_KEY)).toBe(true);
  });

  /**
   * An old workspace's folder notes are `README.md`, with the same bytes the
   * scaffold writes today. Detection must still recognise them as ours, or a
   * half-finished old layout could never be resumed.
   */
  test("old README.md folder notes are still recognised as ours, so a resume finishes the layout", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });
    // Make it an old-style layout: the folder notes sit under their old name.
    for (const folder of PARA_FOLDERS) {
      const body = store.objects.get(`${folder}/about.md`)!.body;
      store.objects.delete(`${folder}/about.md`);
      store.seed(`${folder}/README.md`, body);
    }
    // ...and the layout was cut short: the last two folders never landed.
    store.objects.delete("2-areas/README.md");
    store.objects.delete("9-archive/README.md");

    expect(await hasForeignContent(store, scaffoldFiles("para"))).toBe(false);
    const resumed = await scaffoldContext(store, { structureTemplate: "para", resume: true });
    expect(resumed.reason).toBe("created");
    // The folders that already had their note under the old name are not
    // given a second one beside it.
    expect(store.objects.has("0-inbox/about.md")).toBe(false);
    expect(store.objects.has("1-projects/about.md")).toBe(false);
    expect(resumed.skipped).toEqual(
      expect.arrayContaining(["0-inbox/about.md", "1-projects/about.md"]),
    );
  });

  test("a README.md in a scaffolded folder that is not ours still makes a resume refuse", async () => {
    const store = memoryStore();
    await scaffoldContext(store, { structureTemplate: "para" });
    store.objects.delete("1-projects/about.md");
    store.seed("1-projects/README.md", "my own words, not yours\n");

    expect(await hasForeignContent(store, scaffoldFiles("para"))).toBe(true);
    const resumed = await scaffoldContext(store, { structureTemplate: "para", resume: true });
    expect(resumed).toMatchObject({ scaffolded: false, reason: "existing-context" });
  });
});
