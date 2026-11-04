/**
 * The setup read's narrowing is made in two places: here for `/gateway/binding` (`functions/lib/texSetupRead.ts`
 * `setupRules`), and in the pin's own workspace object when the gateway opens the setup read there without asking the
 * control plane (`apps/mcp/src/workspaceStore/setupRules.js`, 2026-11-04). The two must answer every path alike.
 *
 * Sabotage: make the object's copy keep a rule outside the setup folders, or drop a parent's visibility → this fails.
 *
 * Every value here is fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { effectiveVisibility, type PrivacyRule, type Visibility } from "../functions/lib/privacy";
import { setupRules, SETUP_FOLDERS } from "../functions/lib/texSetupRead";
import { setupHeldRules, SETUP_FOLDERS as OBJECT_SETUP_FOLDERS } from "../../mcp/src/workspaceStore/setupRules.js";

const VIS: Visibility[] = ["private", "team"];
const PREFIXES = ["", "ai", "ai/production", "ai/production/skills", "ai/agents", "ai/agentsx", "ai/productionx", "staff", "ai/agents/helpers"];
const PATHS = [
  "ai/production/texting-assistant.md",
  "ai/production/skills/book.md",
  "ai/agents/helper.md",
  "ai/agents/helpers/one.md",
  "ai/agentsx/leak.md",
  "ai/productionx/leak.md",
  "ai/other.md",
  "staff/secret.md",
  "top.md",
];

/** A small deterministic generator, so a failure names the same rules on every run. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("the object's setup narrowing answers as the control plane's", () => {
  test("the same folders", () => {
    expect([...OBJECT_SETUP_FOLDERS]).toEqual([...SETUP_FOLDERS]);
  });

  test("every path, over many member rule sets", () => {
    const random = generator(20261104);
    for (let round = 0; round < 400; round += 1) {
      const rules: PrivacyRule[] = PREFIXES.filter(() => random() < 0.5).map((prefix) => ({ prefix, vis: VIS[Math.floor(random() * 2)] }));
      const overrides = new Map<string, Visibility>(PATHS.filter(() => random() < 0.3).map((path) => [path, VIS[Math.floor(random() * 2)]]));
      const convex = setupRules({ rules, overrides } as Parameters<typeof setupRules>[0]);
      const held = setupHeldRules({
        etag: "e.1",
        accessVersion: 3,
        folders: rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
        notes: [...overrides].map(([path, visibility]) => ({ path, visibility })),
      });
      expect(held).not.toBeNull();
      const objectRules = held!.folders.map((folder: { prefix: string; visibility: Visibility }) => ({ prefix: folder.prefix, vis: folder.visibility }));
      const objectOverrides = new Map<string, Visibility>(held!.notes.map((note: { path: string; visibility: Visibility }) => [note.path, note.visibility]));
      for (const path of PATHS) {
        expect(effectiveVisibility(path, objectRules, objectOverrides), `${path} under ${JSON.stringify({ rules, overrides: [...overrides] })}`).toBe(
          effectiveVisibility(path, convex.rules, convex.overrides),
        );
      }
      expect(held!.accessVersion).toBe(3);
      expect(held!.etag).toBe("e.1");
    }
  });

  test("nothing outside the setup folders is ever team", () => {
    const held = setupHeldRules({ accessVersion: 1, folders: [{ prefix: "ai", visibility: "team" }, { prefix: "staff", visibility: "team" }], notes: [{ path: "staff/secret.md", visibility: "team" }] });
    const objectRules = held!.folders.map((folder: { prefix: string; visibility: Visibility }) => ({ prefix: folder.prefix, vis: folder.visibility }));
    const objectOverrides = new Map<string, Visibility>(held!.notes.map((note: { path: string; visibility: Visibility }) => [note.path, note.visibility]));
    expect(effectiveVisibility("staff/secret.md", objectRules, objectOverrides)).toBe("private");
    expect(effectiveVisibility("ai/productionx/leak.md", objectRules, objectOverrides)).toBe("private");
    expect(effectiveVisibility("ai/production/texting-assistant.md", objectRules, objectOverrides)).toBe("team");
  });
});
