/**
 * A row held to its own list reads, in rows mode, as its token: `@#<noteId>` (`lib/nodes/rowAccess.ts`). The token
 * is an id the engine compares, never a name anybody typed, and the tree printed it beside the folder verbatim
 * (`@#01a1…` where its siblings said `team`). Every place that turns a visibility into words says `shared` instead.
 */
import { describe, expect, test } from "@jest/globals";
import { describeVisibility } from "../features/console/files/FileTree";
import type { TreeRow } from "../features/console/files/tree";
import { isGroupVisibility, isListToken, visibilityLabel } from "../features/console/files/types";
import { audienceDetail, audienceName, type AudienceContext } from "../features/console/privacy/audience";
import { folderDefaultLine, rootDefaultLine, visibilityWord } from "../features/console/privacy/words";

const TOKEN = "@#01a14fd9-1a2d-7dd5-b364-08dbbe6a2e4c" as const;
const CONTEXT: AudienceContext = { kind: "shared", slug: "context-lc", viewerIsOwner: true };

function folderRow(marker: TreeRow["marker"]): TreeRow {
  return {
    kind: "folder", key: "areas", path: "areas", name: "areas", label: "areas", depth: 0,
    expanded: false, selected: false, marker, markerIsDefault: true, readOnly: false,
  };
}

describe("a row's list token is never printed", () => {
  test("it is told apart from a group, which keeps its name", () => {
    expect(isListToken(TOKEN)).toBe(true);
    expect(isGroupVisibility(TOKEN)).toBe(true);
    expect(isListToken("@design")).toBe(false);
    expect(visibilityLabel(TOKEN)).toBe("shared");
    expect(visibilityLabel("@design")).toBe("@design");
    expect(visibilityLabel("team")).toBe("team");
    expect(visibilityLabel("private")).toBe("private");
  });

  test("the tree's screen-reader line", () => {
    expect(describeVisibility(folderRow(TOKEN))).toBe("areas folder default is shared. Change it from the folder's menu.");
    expect(describeVisibility(folderRow("team"))).toBe("areas folder default is team. Change it from the folder's menu.");
  });

  test("the privacy panel's pill and default lines", () => {
    expect(visibilityWord(TOKEN)).toBe("Shared");
    expect(visibilityWord("@design")).toBe("@design");
    for (const line of [rootDefaultLine(TOKEN), folderDefaultLine(TOKEN)]) {
      expect(line).not.toContain("@#");
      expect(line).toContain("the people it is shared with");
    }
  });

  test("the audience name and sentence", () => {
    expect(audienceName(TOKEN, CONTEXT)).toBe("Shared");
    expect(audienceDetail(TOKEN, CONTEXT)).toBe("Only the people it is shared with, and this context's owners.");
    expect(audienceName("@design", CONTEXT, 2)).toBe("@design (2 people)");
  });
});
