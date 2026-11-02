/**
 * A Tex guest chat is judged the same way by its workspace object as by the control plane. The object renders the
 * guest rules it holds for the chat's names (`apps/mcp/src/workspaceStore/chatRules.js` `chatRulesFrom`), and the
 * control plane renders its own (`lib/nodes/chatFolders.ts` `chatRules`, which the binding hands the gateway). For
 * every path, scope and set of names here, both renderings must let the chat's session see the same notes, judged
 * with the names the gateway's session reads by (`apps/mcp/src/session.js` `grantedGroupsOf`).
 *
 * Sabotage, each confirmed to fail a case here: make the object open a token without checking the chat holds it, or
 * keep a non-token visibility (`team`) as it is instead of making it `private`.
 */

import { describe, expect, test } from "vitest";
import { canSee, PrivacyOverrides, SEALED, type Visibility } from "../functions/lib/privacy";
import { chatRules } from "../functions/lib/nodes/chatFolders";
import { chatRulesFrom, chatTokens } from "../../mcp/src/workspaceStore/chatRules.js";
import { grantedGroupsOf } from "../../mcp/src/session.js";

const GUEST = {
  folders: [
    { prefix: "", visibility: "team" },
    { prefix: "1-projects", visibility: "team" },
    { prefix: "1-projects/secret", visibility: "private" },
    { prefix: "tex/groups/home", visibility: "@#home" },
    { prefix: "tex/groups/home/inner", visibility: "@#other" },
    { prefix: "shared", visibility: "@#row1" },
    { prefix: "sealed", visibility: SEALED },
    { prefix: "sealed/open", visibility: "@#row1" },
  ],
  notes: [
    { path: "1-projects/one.md", visibility: "@#home" },
    { path: "tex/groups/home/held.md", visibility: "private" },
    { path: "shared/team.md", visibility: "team" },
  ],
};

const PATHS = [
  "index.md",
  "1-projects/a.md",
  "1-projects/one.md",
  "1-projects/secret/b.md",
  "tex/groups/home/memory.md",
  "tex/groups/home/held.md",
  "tex/groups/home/inner/c.md",
  "shared/d.md",
  "shared/team.md",
  "sealed/e.md",
  "sealed/open/f.md",
];

/** A chat's names as its grant holds them (without `@`), as the control plane writes them. */
const NAME_SETS: string[][] = [
  ["#reads-as-chat", "#home", "#home!edit"],
  ["#reads-as-guest", "#row1", "#reads-as-chat", "#home", "#home!edit"],
  ["#reads-as-chat", "#row1"],
  ["#reads-as-chat"],
  ["#reads-as-chat", "#other", "design"],
];

function controlPlaneRendering(names: string[]) {
  const overrides = new PrivacyOverrides();
  for (const note of GUEST.notes) overrides.set(note.path, note.visibility as Visibility);
  const rendered = chatRules({ rules: GUEST.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility as Visibility })), overrides }, names);
  return { rules: rendered.rules, overrides: rendered.overrides };
}

function objectRendering(names: string[]) {
  const held = chatRulesFrom({ ...GUEST, accessVersion: 1 }, chatTokens(names.map((name) => `@${name}`))!);
  const overrides = new PrivacyOverrides();
  for (const note of held.notes) overrides.set(note.path, note.visibility as Visibility);
  return { rules: held.folders.map((folder: { prefix: string; visibility: string }) => ({ prefix: folder.prefix, vis: folder.visibility as Visibility })), overrides };
}

describe("a Tex guest chat is judged alike by its workspace object and the control plane", () => {
  for (const names of NAME_SETS) {
    for (const scope of ["team", "private"] as const) {
      test(`${names.join(" ")} at ${scope}`, () => {
        const groups = grantedGroupsOf(names) as Set<string>;
        const cp = controlPlaneRendering(names);
        const ob = objectRendering(names);
        const judged = PATHS.map((path) => [path, canSee(path, scope, cp.rules, cp.overrides, groups), canSee(path, scope, ob.rules, ob.overrides, groups)]);
        expect(judged.map(([path, , object]) => [path, object])).toEqual(judged.map(([path, control]) => [path, control]));
      });
    }
  }

  test("the chat sees its home and what its tokens open, and nothing the team or a name it lacks opens", () => {
    const names = NAME_SETS[0];
    const ob = objectRendering(names);
    const seen = PATHS.filter((path) => canSee(path, "team", ob.rules, ob.overrides, grantedGroupsOf(names) as Set<string>));
    expect(seen).toEqual(["1-projects/one.md", "tex/groups/home/memory.md"]);
  });
});
