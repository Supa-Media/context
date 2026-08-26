import { describe, expect, test } from "@jest/globals";
import {
  DEMO_CONTEXT_TREES,
  DEMO_GRAPH,
  DEMO_INGESTION,
  demoTreeFor,
} from "../features/console/placeholderData";
import { buildTreeRows } from "../features/console/files/tree";

/**
 * The demo has to be three different contexts, not one tree shown three times.
 *
 * That was the bug: whichever context you picked, Browse drew the same folders,
 * which made the rail look like decoration. These tests pin the properties that
 * make each one say something — and the privacy property in particular, since
 * `@lk` exists to show what team access does and does not let you see.
 */

const ids = ["seyi", "lk", "pw"] as const;

function pathsIn(id: string): string[] {
  const tree = demoTreeFor(id);
  return Object.values(tree.listings).flatMap((listing) =>
    listing.entries.map((entry) => entry.path),
  );
}

describe("each demo context has its own tree", () => {
  test("all three are present", () => {
    expect(Object.keys(DEMO_CONTEXT_TREES).sort()).toEqual(["lk", "pw", "seyi"]);
  });

  test("no two contexts show the same root listing", () => {
    const roots = ids.map((id) => JSON.stringify(demoTreeFor(id).listings[""]));
    expect(new Set(roots).size).toBe(3);
  });

  test("no two contexts open on the same note", () => {
    const selections = ids.map((id) => demoTreeFor(id).defaultSelection);
    expect(new Set(selections).size).toBe(3);
  });

  test("whatever each opens on is a note that exists in that context", () => {
    for (const id of ids) {
      const tree = demoTreeFor(id);
      expect(Object.keys(tree.notes)).toContain(tree.defaultSelection);
      expect(pathsIn(id)).toContain(tree.defaultSelection);
    }
  });

  test("an unknown context falls back rather than rendering an empty console", () => {
    expect(demoTreeFor("nope")).toBe(demoTreeFor("seyi"));
    expect(demoTreeFor(null)).toBe(demoTreeFor("seyi"));
  });
});

describe("@seyi — a personal context you own", () => {
  test("carries the full PARA set", () => {
    const roots = demoTreeFor("seyi")
      .listings[""]!.entries.filter((entry) => entry.kind === "folder")
      .map((entry) => entry.name);
    expect(roots).toEqual(["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"]);
  });

  test("has projects and standing areas, not only projects", () => {
    expect(demoTreeFor("seyi").listings["2-areas"]?.entries.length).toBeGreaterThan(0);
    expect(demoTreeFor("seyi").listings["1-projects"]?.entries.length).toBeGreaterThan(0);
  });

  test("has private things held back from a team folder", () => {
    const exceptions = pathsIn("seyi").filter((path) => {
      const tree = demoTreeFor("seyi");
      return Object.values(tree.listings).some((listing) =>
        listing.entries.some((entry) => entry.path === path && entry.exception),
      );
    });
    expect(exceptions.length).toBeGreaterThan(0);
  });
});

describe("@lk — someone else's context, team access", () => {
  test("is visibly smaller than the context you own", () => {
    expect(pathsIn("lk").length).toBeLessThan(pathsIn("seyi").length);
  });

  test("shows nothing private at all — that is the privacy model, not an omission", () => {
    const tree = demoTreeFor("lk");
    const visible = Object.values(tree.listings).flatMap((listing) =>
      listing.entries.filter((entry) => entry.name !== "privacy.md"),
    );
    expect(visible.every((entry) => entry.visibility === "team")).toBe(true);
  });

  test("says so in words rather than looking like an empty state", () => {
    expect(demoTreeFor("lk").readOnlyReason).toMatch(/team access/);
    expect(demoTreeFor("lk").readOnlyReason).toMatch(/not a loading state/);
  });

  test("has no 0-inbox, because a guest is not shown one", () => {
    expect(Object.keys(demoTreeFor("lk").listings)).not.toContain("0-inbox");
  });
});

describe("@public-worship — the shared context", () => {
  test("replaced @ignite-2026 everywhere, including on the map", () => {
    const labels = DEMO_GRAPH.nodes.map((node) => node.label);
    expect(labels).toContain("@public-worship");
    expect(labels).not.toContain("@ignite-2026");
  });

  test("its map node is drawn as shared, with more than one member", () => {
    const node = DEMO_GRAPH.nodes.find((candidate) => candidate.label === "@public-worship");
    expect(node?.kind).toBe("shared");
    expect(node?.sub).toMatch(/members/);
  });

  test("every map edge points at a node that exists", () => {
    const ids2 = new Set(DEMO_GRAPH.nodes.map((node) => node.id));
    for (const edge of DEMO_GRAPH.edges) {
      expect(ids2.has(edge.from)).toBe(true);
      expect(ids2.has(edge.to)).toBe(true);
    }
  });

  test("is team by default, which is what a shared context means", () => {
    expect(demoTreeFor("pw").listings[""]?.folderDefault).toBe("team");
  });

  test("carries the organisation's real workstreams", () => {
    const paths = pathsIn("pw").join(" ");
    for (const workstream of [
      "ltn-2026",
      "dc-chapter",
      "academy-pw-101",
      "org-chart",
      "financial-transparency",
      "worship-with-strangers",
      "doxology-framework",
    ]) {
      expect(paths).toContain(workstream);
    }
  });

  test("the material is real rather than lorem", () => {
    const notes = Object.values(demoTreeFor("pw").notes).join("\n");
    expect(notes).toContain("Central Park Bandshell");
    expect(notes).toContain("501(c)(3)");
    expect(notes).toContain("Matthew 13");
    expect(notes).toContain("presence over performance");
    expect(notes).toContain("The Heart");
    expect(notes).toContain("The Craft");
    expect(notes).toContain("The Witness");
  });

  test("still keeps one thing private, so the model is visible here too", () => {
    const exceptions = demoTreeFor("pw").listings["1-projects"]!.entries.filter(
      (entry) => entry.exception,
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.visibility).toBe("private");
  });
});

describe("the tree the Browse pane will actually draw", () => {
  test("renders from each context's own listings", () => {
    for (const id of ids) {
      const tree = demoTreeFor(id);
      const rows = buildTreeRows({
        listings: tree.listings,
        expanded: new Set(tree.defaultExpanded),
        selectedPath: tree.defaultSelection,
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.path === tree.defaultSelection)).toBe(true);
    }
  });

  test("switching context changes the rows, not just the label", () => {
    const rowsFor = (id: string) => {
      const tree = demoTreeFor(id);
      return buildTreeRows({
        listings: tree.listings,
        expanded: new Set(tree.defaultExpanded),
        selectedPath: tree.defaultSelection,
      }).map((row) => row.path);
    };
    expect(rowsFor("seyi")).not.toEqual(rowsFor("lk"));
    expect(rowsFor("lk")).not.toEqual(rowsFor("pw"));
    expect(rowsFor("seyi")).not.toEqual(rowsFor("pw"));
  });

  test("the note open in one context is not a path in another", () => {
    // The reset in `useDemoFileBrowser` exists for exactly this: keeping a
    // selection across a context switch would show one context's note under
    // another context's name.
    expect(pathsIn("lk")).not.toContain(demoTreeFor("seyi").defaultSelection);
    expect(pathsIn("seyi")).not.toContain(demoTreeFor("lk").defaultSelection);
  });
});

describe("the demo's ingestion rules", () => {
  test("only the personal contexts have any", () => {
    // `@public-worship` is the shared one, and a shared context has no capture
    // address at all. Mocking one up would teach a visitor a model the product
    // does not implement — which is the bug this is here to keep out.
    expect(Object.keys(DEMO_INGESTION).sort()).toEqual(["lk", "seyi"]);
    expect(DEMO_INGESTION.pw).toBeUndefined();
  });

  test("each context that has one has its own address", () => {
    const addresses = Object.values(DEMO_INGESTION).map((settings) => settings.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test("none of them is an open drop-box", () => {
    for (const settings of Object.values(DEMO_INGESTION)) {
      expect(settings.allowAnySender).toBe(false);
    }
  });

  test("between them they show an address rule and a domain rule", () => {
    expect(DEMO_INGESTION.seyi!.allowedSenders.length).toBeGreaterThan(0);
    expect(DEMO_INGESTION.seyi!.allowedDomains).toEqual([]);
    expect(DEMO_INGESTION.lk!.allowedDomains.length).toBeGreaterThan(0);
    expect(DEMO_INGESTION.lk!.allowedSenders).toEqual([]);
  });
});
