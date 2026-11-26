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
  isArea,
  isBotCardPath,
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
    for (const key of ["owner", "delegate", "helper", "modes", "metrics", "approvals"]) {
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
  test("reads owner, delegate, modes, metrics and approvals", () => {
    const notes = [
      note(
        "areas/finance/about.md",
        {
          owner: "@dev2",
          delegate: "Claude Code",
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
      delegate: "Claude Code",
      modes: ["Manager", "Doer"],
      metrics: [
        { name: "PR time to ship", target: "2 days" },
        { name: "Open bugs", target: null },
      ],
      approvals: ["Spending over $20 needs the owner's approval."],
    });
    expect(seat.about).toEqual({ target: "areas/finance/about.md", creates: false });
    // The old name of the line is still read, and the new one wins over it.
    expect(seatOf("areas/finance", ROOT, [note("areas/finance/about.md", { owner: "@dev2", helper: "Old Bot" })]).delegate).toBe("Old Bot");
    expect(seatOf("areas/finance", ROOT, [note("areas/finance/about.md", { owner: "@dev2", helper: "Old Bot", delegate: "Finance" })]).delegate).toBe("Finance");
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

});

describe("seatChanges", () => {
  test("empty values become null, so they are removed rather than left blank", () => {
    expect(
      seatChanges({ owner: "  ", delegate: "", modes: [], metrics: [], approvals: ["  ", ""] }),
    ).toEqual([
      ["owner", null],
      ["delegate", null],
      // The delegate's old name is cleared, so the note never says two things.
      ["helper", null],
      ["modes", null],
      ["metrics", null],
      // A hand-written `metric:` and `target:` would win over the line just written, so saving removes them.
      ["metric", null],
      ["target", null],
      ["approvals", null],
    ]);
  });

  test("modes are written in MODES order, whatever order they were picked in", () => {
    const [, , , modes] = seatChanges({ owner: "@dev2", delegate: null, modes: ["Doer", "Manager"], metrics: [], approvals: [] });
    expect(modes).toEqual(["modes", ["Manager", "Doer"]]);
  });

  test("blank metric names are dropped; the rest are written as lines", () => {
    const [, , , , metrics] = seatChanges({
      owner: "@dev2",
      delegate: null,
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

  test("owner and delegate are trimmed, and approvals keep their order", () => {
    const changes = seatChanges({ owner: " @dev2 ", delegate: " Claude Code ", modes: [], metrics: [], approvals: [" first ", "second"] });
    expect(changes).toContainEqual(["owner", "@dev2"]);
    expect(changes).toContainEqual(["delegate", "Claude Code"]);
    expect(changes).toContainEqual(["approvals", ["first", "second"]]);
  });

  test("the people folder's about.md keeps it out of the areas", () => {
    expect(PEOPLE_ABOUT).toEqual([["area", "false"]]);
  });
});

describe("cardSlug and cardPath", () => {
  test("a person's new card goes in people/, a bot's in bots/<bot>/about.md beside the Areas folder", () => {
    // The owner, 2026-11-25: "areas/bots should replace areas/people, as a place to configure everything about the
    // available bots", then "top level bots yes".
    expect(cardSlug("@dev2")).toBe("dev2");
    expect(cardPath(ROOT, "@dev2", [], "person")).toBe("areas/people/dev2.md");
    expect(cardPath(ROOT, "Finance Bot")).toBe("bots/finance-bot/about.md");
  });

  test("a card already written is found where it is, in bots/ first", () => {
    expect(cardSlug("Claude Code")).toBe("claude-code");
    const old = [note("areas/people/claude-code.md", { kind: "agent" })];
    expect(cardPath(ROOT, "Claude Code", old)).toBe("areas/people/claude-code.md");
    const both = [...old, note("areas/bots/claude-code/about.md", { kind: "agent" })];
    expect(cardPath(ROOT, "Claude Code", both)).toBe("areas/bots/claude-code/about.md");
    expect(cardOf("Claude Code", "agent", ROOT, both).path).toBe("areas/bots/claude-code/about.md");
    const moved = [...both, note("bots/claude-code/about.md", { kind: "agent" })];
    expect(cardPath(ROOT, "Claude Code", moved)).toBe("bots/claude-code/about.md");
    expect(isBotCardPath(ROOT, "bots/claude-code/about.md")).toBe(true);
    expect(isBotCardPath(ROOT, "areas/bots/claude-code/about.md")).toBe(true);
    expect(isBotCardPath(ROOT, "bots/claude-code/mail/seyi.md")).toBe(false);
  });

  test("the bots folder and each bot's folder are never areas", () => {
    const notes = [note("areas/bots/finance/about.md", { kind: "agent", bot: "grok", owner: "@seyi" })];
    expect(isArea("areas/bots", ROOT, notes)).toBe(false);
    expect(isArea("areas/bots/finance", ROOT, notes)).toBe(false);
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
      }),
    ];
    expect(cardOf("@dev2", "agent", ROOT, notes)).toEqual({
      holder: "@dev2",
      kind: "person",
      phone: "+1 555 010 0177",
      email: "dev2@example.com",
      access: "",
      vault: "", bot: "", belongsTo: "", reach: "mail", avatar: "", worksIn: [],
      creates: false,
      path: "areas/people/dev2.md",
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
    access: "should not be written",
    vault: "should not be written",
    bot: "",
    belongsTo: "",
    reach: "mail",
    avatar: "",
  };
  const agent: Card = {
    holder: "Claude Code",
    kind: "agent",
    phone: "+1 555 010 0199",
    email: "agent@example.com",
    access: "Claude Code in the dev2 repo",
    vault: "dev2 agent item",
    bot: "",
    belongsTo: "",
    reach: "mail",
    avatar: "",
  };

  test("a bot's card keeps its logo, and a person's never has one", () => {
    expect(cardChanges({ ...agent, bot: "grok", avatar: "upload-0123456789abcdef.png" })).toContainEqual(["avatar", "upload-0123456789abcdef.png"]);
    expect(cardChanges({ ...person, avatar: "upload-0123456789abcdef.png" })).toContainEqual(["avatar", null]);
  });

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

  test("a card's old delegation lines are cleared: a delegate is per area now", () => {
    expect(cardChanges(person)).toEqual(expect.arrayContaining([["delegation", null], ["delegation_how", null]]));
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
  test("a person's line is phone and email", () => {
    const line = reachLine({ holder: "@dev2", kind: "person", phone: "+1 555 010 0177", email: "dev2@example.com", access: "", vault: "", bot: "", belongsTo: "", reach: "mail", avatar: "" });
    expect(line).toBe("+1 555 010 0177 · dev2@example.com");
  });

  test("an agent's line is its access and the vault item name, never a login", () => {
    const line = reachLine({
      holder: "Claude Code",
      kind: "agent",
      phone: "",
      email: "",
      access: "Claude Code in the dev2 repo",
      vault: "dev2 agent item",
      bot: "",
      belongsTo: "",
      reach: "mail",
      avatar: "",
    });
    expect(line).toBe("Claude Code in the dev2 repo · login in the vault: dev2 agent item");
  });

  test("an empty card gives an empty line", () => {
    expect(reachLine({ holder: "@dev2", kind: "person", phone: "", email: "", access: "", vault: "", bot: "", belongsTo: "", reach: "mail", avatar: "" })).toBe("");
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

describe("bot cards (the owner, 2026-11-25: Grok bots own areas)", () => {
  const ROOT_B = "areas";
  test("a bot card says what kind of bot, whose it is and how it is reached", () => {
    const card = cardOf("Finance", "agent", ROOT_B, [note("areas/people/finance.md", { kind: "agent", bot: "Grok", belongs_to: "@seyi", reach: "webhook" })]);
    expect(card).toMatchObject({ kind: "agent", bot: "grok", belongsTo: "@seyi", reach: "webhook" });
  });

  test("an unknown bot word is a plain agent, and a bot with no reach checks its own mail", () => {
    const card = cardOf("Finance", "agent", ROOT_B, [note("areas/people/finance.md", { kind: "agent", bot: "toaster" })]);
    expect(card).toMatchObject({ bot: "", reach: "mail", avatar: "" });
  });

  test("a bot's lines are written for a bot, and never for a person or a plain agent", () => {
    const bot: Card = { holder: "Finance", kind: "agent", phone: "", email: "", access: "", vault: "", bot: "grok", belongsTo: "@seyi", reach: "mail", avatar: "" };
    expect(cardChanges(bot)).toEqual(expect.arrayContaining([["bot", "grok"], ["belongs_to", "@seyi"], ["reach", "mail"]]));
    expect(cardChanges({ ...bot, bot: "" })).toEqual(expect.arrayContaining([["bot", null], ["belongs_to", null], ["reach", null]]));
    expect(cardChanges({ ...bot, kind: "person" })).toEqual(expect.arrayContaining([["bot", null], ["belongs_to", null], ["reach", null]]));
  });

  test("a bot's reach line says whose bot it is", () => {
    const line = reachLine({ holder: "Finance", kind: "agent", phone: "", email: "", access: "", vault: "", bot: "grok", belongsTo: "@seyi", reach: "mail", avatar: "" });
    expect(line).toBe("@seyi's Grok bot");
  });
});
