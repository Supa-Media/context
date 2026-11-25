/**
 * Areas as seats: what an area's `about.md` says about who holds it, and the
 * card that says how to reach them. Pure model tests with small fake notes.
 */

import { describe, expect, test } from "@jest/globals";
import { setNoteProperty } from "../../mcp/src/lists/setProperty.js";
import {
  MODES,
  PEOPLE_ABOUT,
  areaTree,
  cardChanges,
  cardOf,
  cardPath,
  cardSlug,
  healthOf,
  areaTitle,
  kindCounts,
  needLook,
  isArea,
  metricLine,
  parseMetric,
  reachLine,
  seatChanges,
  seatOf,
  type Card,
} from "../features/console/files/folderPage/areas/seat";
import type { ListNote } from "../features/console/files/listBlock/model";

const ROOT = "areas";

const note = (path: string, properties: Record<string, string | readonly string[]> = {}, extra: Partial<ListNote> = {}): ListNote => ({
  path,
  properties,
  updatedAt: 1_000,
  ...extra,
});

describe("isArea", () => {
  test("a direct child of the areas root is an area", () => {
    expect(isArea("areas/finance", ROOT, [])).toBe(true);
  });

  test("a direct child whose about.md says area: false is not one", () => {
    const notes = [note("areas/finance/about.md", { area: "false", owner: "@dev2" })];
    expect(isArea("areas/finance", ROOT, notes)).toBe(false);
  });

  test("a deeper folder with no seat and no area line is a plain folder", () => {
    const notes = [note("areas/finance/receipts/jan.md")];
    expect(isArea("areas/finance/receipts", ROOT, notes)).toBe(false);
  });

  test("a deeper folder is an area when its about.md declares any seat key", () => {
    for (const key of ["owner", "helper", "modes", "metrics", "approvals"]) {
      const notes = [note("areas/finance/tax/about.md", { [key]: "x" })];
      expect(isArea("areas/finance/tax", ROOT, notes)).toBe(true);
    }
  });

  test("a deeper folder is an area with area: true, and not with area: no", () => {
    expect(isArea("areas/finance/tax", ROOT, [note("areas/finance/tax/about.md", { area: "true" })])).toBe(true);
    expect(isArea("areas/finance/tax", ROOT, [note("areas/finance/tax/about.md", { area: "no", owner: "@dev2" })])).toBe(false);
  });

  test("the root itself is not an area", () => {
    expect(isArea(ROOT, ROOT, [])).toBe(false);
  });

  test("a folder outside the root is not an area, even one named like the root", () => {
    expect(isArea("projects/finance", ROOT, [])).toBe(false);
    expect(isArea("areasx/finance", ROOT, [])).toBe(false);
  });
});

describe("seatOf", () => {
  test("reads owner, helper, modes, metrics and approvals", () => {
    const notes = [
      note(
        "areas/finance/about.md",
        {
          owner: "@dev2",
          helper: "Claude Code",
          modes: ["doer", "MANAGER", "bogus"],
          metrics: ["PR time to ship, target 2 days", "Open bugs"],
          approvals: ["Spending over $20 needs the owner's approval."],
        },
      ),
    ];
    const seat = seatOf("areas/finance", ROOT, notes);
    expect(seat).toMatchObject({
      folder: "areas/finance",
      name: "finance",
      ownOwner: "@dev2",
      owner: "@dev2",
      ownerFrom: null,
      helper: "Claude Code",
      modes: ["Manager", "Doer"],
      metrics: [
        { name: "PR time to ship", target: "2 days" },
        { name: "Open bugs", target: null },
      ],
      approvals: ["Spending over $20 needs the owner's approval."],
    });
    expect(seat.about).toEqual({ target: "areas/finance/about.md", creates: false });
  });

  test("owner written as a list is its first name", () => {
    const notes = [note("areas/finance/about.md", { owner: ["@dev2", "@dev3"] })];
    expect(seatOf("areas/finance", ROOT, notes).owner).toBe("@dev2");
  });

  test("modes come back in MODES order, whatever order they were written in, and unknown words are dropped", () => {
    const notes = [note("areas/finance/about.md", { modes: ["Doer", "Visionary", "nonsense"] })];
    expect(seatOf("areas/finance", ROOT, notes).modes).toEqual(["Visionary", "Doer"]);
    expect(MODES).toEqual(["Visionary", "Manager", "Doer"]);
  });

  test("inherits the owner from the nearest area above that names one, and says where it came from", () => {
    const notes = [
      note("areas/finance/about.md", { owner: "@dev2" }),
      note("areas/finance/tax/about.md", { owner: "@dev3" }),
      note("areas/finance/tax/filing/about.md", { helper: "Tex" }),
      note("areas/finance/bills/about.md", { helper: "Tex" }),
    ];
    const filing = seatOf("areas/finance/tax/filing", ROOT, notes);
    expect(filing).toMatchObject({ ownOwner: null, owner: "@dev3", ownerFrom: "areas/finance/tax" });

    const bills = seatOf("areas/finance/bills", ROOT, notes);
    expect(bills).toMatchObject({ ownOwner: null, owner: "@dev2", ownerFrom: "areas/finance" });
  });

  test("never inherits an owner from the root's own about.md", () => {
    const notes = [note("areas/about.md", { owner: "@root" }), note("areas/finance/about.md", { helper: "Tex" })];
    const seat = seatOf("areas/finance", ROOT, notes);
    expect(seat).toMatchObject({ owner: null, ownerFrom: null });
  });

  test("about.creates is true when there is no about.md", () => {
    const seat = seatOf("areas/finance", ROOT, [note("areas/finance/budget.md")]);
    expect(seat.about).toEqual({ target: "areas/finance/about.md", creates: true });
    expect(seat.owner).toBeNull();
    expect(seat.modes).toEqual([]);
    expect(seat.metrics).toEqual([]);
  });
});

describe("parseMetric and metricLine", () => {
  test("a name and a target round-trip through the line", () => {
    const metric = parseMetric("PR time to ship · target 2 days");
    expect(metric).toEqual({ name: "PR time to ship", target: "2 days" });
    expect(metricLine(metric)).toBe("PR time to ship · target 2 days");
  });

  test("a line written by hand with a comma still reads", () => {
    expect(parseMetric("PR time to ship, target 2 days")).toEqual({ name: "PR time to ship", target: "2 days" });
  });

  // The seat pop-up's save failed on every metric with a target: "Monthly cost, target
  // under $600 cannot hold a comma". What metricLine writes must pass the real writer.
  test("every line it writes is one the seat's metrics list can hold", () => {
    for (const metric of [
      { name: "Monthly cost", target: "under $600" },
      { name: "Revenue", target: "over $1,000,000" },
      { name: "Burn, per user", target: "under $3" },
    ]) {
      const line = metricLine(metric);
      const written = setNoteProperty("# Finance\n", "metrics", [line]);
      expect(written).not.toHaveProperty("error");
      expect(parseMetric(line).name).toBe(metric.name.replace(/,/g, ""));
    }
    expect(metricLine({ name: "Revenue", target: "over $1,000,000" })).toBe("Revenue · target over $1000000");
  });

  test("a line with no target is all name, and round-trips too", () => {
    const metric = parseMetric("Open bugs");
    expect(metric).toEqual({ name: "Open bugs", target: null });
    expect(metricLine(metric)).toBe("Open bugs");
  });
});

describe("areaTree", () => {
  const notes = [
    note("areas/about.md", { owner: "@root" }),
    note("areas/people/about.md", { area: "false" }),
    note("areas/people/dev2.md", { kind: "person", phone: "+1 555 010 0177" }),
    note("areas/finance/about.md", { owner: "@dev2" }),
    note("areas/finance/tax/about.md", { owner: "@dev3" }),
    note("areas/finance/bills/about.md", { modes: ["Doer"] }),
    note("areas/finance/budget.md"),
    note("areas/finance/receipts/jan.md"),
    note("areas/alpha/about.md", { helper: "Tex" }),
  ];

  test("sub-areas are listed in name order", () => {
    const tree = areaTree("areas/finance", ROOT, notes);
    expect(tree.areas.map((area) => area.seat.name)).toEqual(["bills", "tax"]);
  });

  test("the tree's sub-areas inherit the owner from their parent area", () => {
    const tree = areaTree("areas/finance", ROOT, notes);
    expect(tree.seat.owner).toBe("@dev2");
    expect(tree.areas.find((area) => area.seat.name === "bills")!.seat.owner).toBe("@dev2");
    expect(tree.areas.find((area) => area.seat.name === "tax")!.seat.owner).toBe("@dev3");
  });

  test("files exclude about.md", () => {
    const tree = areaTree("areas/finance", ROOT, notes);
    expect(tree.files.map((file) => file.path)).not.toContain("areas/finance/about.md");
    expect(tree.files.map((file) => file.name)).not.toContain("about.md");
  });

  test("a plain deeper folder appears in files, not in areas", () => {
    const tree = areaTree("areas/finance", ROOT, notes);
    expect(tree.areas.map((area) => area.seat.folder)).not.toContain("areas/finance/receipts");
    expect(tree.files).toEqual([
      expect.objectContaining({ kind: "file", path: "areas/finance/budget.md", name: "budget.md" }),
      expect.objectContaining({ kind: "folder", path: "areas/finance/receipts", name: "receipts" }),
    ]);
  });

  test("the root's people folder is not a row, and its cards are not areas", () => {
    const tree = areaTree(ROOT, ROOT, notes);
    expect(tree.areas.map((area) => area.seat.name)).toEqual(["alpha", "finance"]);
    expect(tree.files.map((file) => file.path)).not.toContain("areas/people");
    expect(tree.files.map((file) => file.path)).not.toContain("areas/about.md");
  });

  /*
    Suspected bug, left failing on purpose: areaTree tests isArea before the
    people-folder skip, so a `people/` folder whose about.md has not been
    written yet (no `area: false` line) is drawn as an area, not skipped.
  */
  test("a people folder with no about.md yet is still not an area", () => {
    const bare = [note("areas/people/dev2.md", { kind: "person", phone: "+1 555 010 0177" }), note("areas/finance/about.md", {})];
    const tree = areaTree(ROOT, ROOT, bare);
    expect(tree.areas.map((area) => area.seat.folder)).not.toContain("areas/people");
    expect(tree.files.map((file) => file.path)).not.toContain("areas/people");
  });
});

describe("healthOf", () => {
  test("an empty seat is a ring: it says No owner itself and offers Assign owner (prototype)", () => {
    expect(healthOf(seatOf("areas/finance", ROOT, []))).toBe("ring");
  });

  test("modes are labels: a seat with no Manager is not flagged (owner, 2026-11-24)", () => {
    const notes = [note("areas/finance/about.md", { owner: "@dev2", modes: ["Visionary", "Doer"] })];
    expect(healthOf(seatOf("areas/finance", ROOT, notes))).toBe("neutral");
  });

  test("amber when the first metric misses its target; no owner still wins", () => {
    const owned = seatOf("areas/finance", ROOT, [note("areas/finance/about.md", { owner: "@dev2" })]);
    expect(healthOf(owned, true)).toBe("warn");
    expect(healthOf(seatOf("areas/finance", ROOT, [note("areas/finance/about.md", { modes: ["Doer"] })]), true)).toBe("ring");
  });
});

describe("chart and list helpers", () => {
  test("areaTitle draws a folder name as a title", () => {
    expect(areaTitle("pipeline-watch")).toBe("Pipeline watch");
    expect(areaTitle("2-areas")).toBe("Areas");
    expect(areaTitle("finance")).toBe("Finance");
  });

  test("kindCounts counts an area's files by kind", () => {
    const files = [
      { kind: "file" as const, path: "a/m.csv", name: "m.csv" },
      { kind: "file" as const, path: "a/v.csv", name: "v.csv" },
      { kind: "file" as const, path: "a/b.md", name: "b.md" },
      { kind: "folder" as const, path: "a/r", name: "r" },
      { kind: "file" as const, path: "a/s.page.md", name: "s.page.md" },
    ];
    expect(kindCounts(files)).toBe("2 sheets · 1 note · 1 folder · 1 page");
  });

  test("needLook counts the sub-areas with no owner", () => {
    const notes = [
      note("areas/finance/about.md", { owner: "@seyi", modes: ["Manager"] }),
      note("areas/tex/about.md", { owner: "Tex", modes: ["Doer"] }),
      note("areas/design/brand.md", {}),
    ];
    expect(needLook(areaTree("areas", ROOT, notes))).toBe(1);
  });

});

describe("seatChanges", () => {
  test("empty values become null, so they are removed rather than left blank", () => {
    expect(
      seatChanges({ owner: "  ", helper: "", modes: [], metrics: [], approvals: ["  ", ""] }),
    ).toEqual([
      ["owner", null],
      ["helper", null],
      ["modes", null],
      ["metrics", null],
      ["approvals", null],
    ]);
  });

  test("modes are written in MODES order, whatever order they were picked in", () => {
    const [, , modes] = seatChanges({ owner: "@dev2", helper: null, modes: ["Doer", "Manager"], metrics: [], approvals: [] });
    expect(modes).toEqual(["modes", ["Manager", "Doer"]]);
  });

  test("blank metric names are dropped; the rest are written as lines", () => {
    const [, , , metrics] = seatChanges({
      owner: "@dev2",
      helper: null,
      modes: [],
      metrics: [
        { name: "   ", target: "2 days" },
        { name: "PR time to ship", target: "2 days" },
        { name: "Open bugs", target: "" },
      ],
      approvals: [],
    });
    expect(metrics).toEqual(["metrics", ["PR time to ship · target 2 days", "Open bugs"]]);
  });

  test("owner and helper are trimmed, and approvals keep their order", () => {
    const changes = seatChanges({ owner: " @dev2 ", helper: " Claude Code ", modes: [], metrics: [], approvals: [" first ", "second"] });
    expect(changes).toContainEqual(["owner", "@dev2"]);
    expect(changes).toContainEqual(["helper", "Claude Code"]);
    expect(changes).toContainEqual(["approvals", ["first", "second"]]);
  });

  test("the people folder's about.md keeps it out of the areas", () => {
    expect(PEOPLE_ABOUT).toEqual([["area", "false"]]);
  });
});

describe("cardSlug and cardPath", () => {
  test("@dev2 is kept as dev2 under the people folder", () => {
    expect(cardSlug("@dev2")).toBe("dev2");
    expect(cardPath(ROOT, "@dev2")).toBe("areas/people/dev2.md");
  });

  test("a name with spaces becomes a dashed slug", () => {
    expect(cardSlug("Claude Code")).toBe("claude-code");
    expect(cardPath(ROOT, "Claude Code")).toBe("areas/people/claude-code.md");
  });

  test("odd input with nothing left falls back to someone", () => {
    expect(cardSlug("")).toBe("someone");
    expect(cardSlug("   ")).toBe("someone");
    expect(cardSlug("@@!!")).toBe("someone");
  });
});

describe("cardOf", () => {
  test("reads the card's fields", () => {
    const notes = [
      note("areas/people/dev2.md", {
        kind: "person",
        phone: "+1 555 010 0177",
        email: "dev2@example.com",
        delegation: "Tex",
        delegation_how: "",
      }),
    ];
    expect(cardOf("@dev2", "agent", ROOT, notes)).toEqual({
      holder: "@dev2",
      kind: "person",
      phone: "+1 555 010 0177",
      email: "dev2@example.com",
      delegation: "Tex",
      delegationHow: "",
      access: "",
      vault: "",
      creates: false,
    });
  });

  test("creates is true when there is no card yet", () => {
    expect(cardOf("@dev2", "person", ROOT, [])).toMatchObject({ creates: true, phone: "", email: "" });
  });

  test("the given kind is the fallback when the card has none, or a wrong one", () => {
    expect(cardOf("@dev2", "person", ROOT, [])).toMatchObject({ kind: "person" });
    expect(cardOf("Claude Code", "agent", ROOT, [note("areas/people/claude-code.md", { kind: "bogus" })])).toMatchObject({ kind: "agent" });
    expect(cardOf("@dev2", "person", ROOT, [note("areas/people/dev2.md", { kind: "agent" })])).toMatchObject({ kind: "agent" });
  });
});

describe("cardChanges", () => {
  const person: Card = {
    holder: "@dev2",
    kind: "person",
    phone: " +1 555 010 0177 ",
    email: "dev2@example.com",
    delegation: "Tex",
    delegationHow: "should not be written",
    access: "should not be written",
    vault: "should not be written",
  };
  const agent: Card = {
    holder: "Claude Code",
    kind: "agent",
    phone: "+1 555 010 0199",
    email: "agent@example.com",
    delegation: "Other Bot",
    delegationHow: "ask in #ops",
    access: "Claude Code in the dev2 repo",
    vault: "dev2 agent item",
  };

  test("a person's card never writes access or vault", () => {
    const changes = cardChanges(person);
    expect(changes).toContainEqual(["access", null]);
    expect(changes).toContainEqual(["vault", null]);
  });

  test("an agent's card never writes phone, email or delegation", () => {
    const changes = cardChanges(agent);
    expect(changes).toContainEqual(["phone", null]);
    expect(changes).toContainEqual(["email", null]);
    expect(changes).toContainEqual(["delegation", null]);
    expect(changes).toContainEqual(["access", "Claude Code in the dev2 repo"]);
    expect(changes).toContainEqual(["vault", "dev2 agent item"]);
  });

  test("delegation_how is written only when the delegate is another bot, not Tex", () => {
    expect(cardChanges({ ...person, delegation: "Other Bot", delegationHow: "ask in #ops" })).toContainEqual(["delegation_how", "ask in #ops"]);
    expect(cardChanges({ ...person, delegation: "Tex", delegationHow: "ask in #ops" })).toContainEqual(["delegation_how", null]);
    expect(cardChanges({ ...person, delegation: "tEx", delegationHow: "ask in #ops" })).toContainEqual(["delegation_how", null]);
    expect(cardChanges({ ...person, delegation: "", delegationHow: "ask in #ops" })).toContainEqual(["delegation_how", null]);
  });

  test("empty lines are removed, not written blank", () => {
    const changes = cardChanges({ ...person, phone: "   ", email: "" });
    expect(changes).toContainEqual(["phone", null]);
    expect(changes).toContainEqual(["email", null]);
  });

  test("no change ever writes a credential key", () => {
    for (const card of [person, agent]) {
      for (const [key] of cardChanges(card)) {
        expect(key).not.toMatch(/password|secret|token|login/i);
      }
    }
  });
});

describe("reachLine", () => {
  test("a person's line is phone, email and who they delegate to", () => {
    const line = reachLine({
      holder: "@dev2",
      kind: "person",
      phone: "+1 555 010 0177",
      email: "dev2@example.com",
      delegation: "Other Bot",
      delegationHow: "ask in #ops",
      access: "",
      vault: "",
    });
    expect(line).toBe("+1 555 010 0177 · dev2@example.com · delegates to Other Bot (ask in #ops)");
  });

  test("a person delegating to Tex gives no how-to", () => {
    const line = reachLine({
      holder: "@dev2",
      kind: "person",
      phone: "",
      email: "dev2@example.com",
      delegation: "Tex",
      delegationHow: "ignored",
      access: "",
      vault: "",
    });
    expect(line).toBe("dev2@example.com · delegates to Tex");
  });

  test("an agent's line is its access and the vault item name, never a login", () => {
    const line = reachLine({
      holder: "Claude Code",
      kind: "agent",
      phone: "",
      email: "",
      delegation: "",
      delegationHow: "",
      access: "Claude Code in the dev2 repo",
      vault: "dev2 agent item",
    });
    expect(line).toBe("Claude Code in the dev2 repo · login in the vault: dev2 agent item");
  });

  test("an empty card gives an empty line", () => {
    expect(reachLine({ holder: "@dev2", kind: "person", phone: "", email: "", delegation: "", delegationHow: "", access: "", vault: "" })).toBe("");
  });
});

describe("a single-line rule keeps its commas", () => {
  test("reads `approvals: Spending over $20, or hiring, needs Seyi` as one rule, while modes still split", () => {
    const { seatOf } = require("../features/console/files/folderPage/areas/seat");
    const seat = seatOf("areas/finance", "areas", [
      { path: "areas/finance/about.md", properties: { approvals: "Spending over $20, or hiring, needs Seyi", modes: "Manager, Doer" } },
    ]);
    expect(seat.approvals).toEqual(["Spending over $20, or hiring, needs Seyi"]);
    expect(seat.modes).toEqual(["Manager", "Doer"]);
  });
});
