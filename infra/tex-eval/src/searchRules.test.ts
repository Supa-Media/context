import { describe, expect, it } from "vitest";
import { searchCounts, searchProblemWith, searchVerdict, type SearchCase } from "./searchRules";

const search = (id: string, extra: Partial<SearchCase> = {}): SearchCase => ({
  id,
  set: "test",
  query: "when does my lease end",
  as: "sam",
  expect: ["@seyi/home/lease.md"],
  kind: "lease",
  notes: { "@seyi/home/lease.md": "The lease ends in June. Words only people read." },
  ...extra,
});

describe("the search rules", () => {
  it("keeps a well-shaped search case, and says in a sentence what is wrong with one that is not", () => {
    expect(searchProblemWith(search("ok"))).toBeNull();
    expect(searchProblemWith(search("Bad Id"))).toMatch(/id/);
    expect(searchProblemWith({ ...search("x"), set: "dev" })).toMatch(/set must be "test"/);
    expect(searchProblemWith({ ...search("x"), query: "" })).toMatch(/query/);
    expect(searchProblemWith({ ...search("x"), query: "q".repeat(301) })).toMatch(/query/);
    expect(searchProblemWith({ ...search("x"), as: "" })).toMatch(/as/);
    expect(searchProblemWith({ ...search("x"), in: "seyi" })).toMatch(/in must/);
    expect(searchProblemWith({ ...search("x"), in: "@seyi" })).toBeNull();
    expect(searchProblemWith({ ...search("x"), expect: [] })).toMatch(/1 to 5/);
    expect(searchProblemWith({ ...search("x"), expect: Array(6).fill("@seyi/a.md") })).toMatch(/1 to 5/);
    expect(searchProblemWith({ ...search("x"), expect: ["lease.md"] })).toMatch(/expected note/);
    expect(searchProblemWith({ ...search("x"), forbid: ["@seyi/a.txt"] })).toMatch(/forbid/);
    expect(searchProblemWith({ ...search("x"), kind: "a lease query" })).toMatch(/kind/);
    expect(searchProblemWith({ ...search("x"), notes: [] as never })).toMatch(/no notes/);
    expect(searchProblemWith({ ...search("x"), notes: { "lease.md": "x" } })).toMatch(/keyed/);
    expect(searchProblemWith({ ...search("x"), notes: { "@seyi/a.md": 3 as never } })).toMatch(/text/);
    expect(searchProblemWith(null)).toMatch(/not a search case/);
  });

  it("caps a search case at 200000 bytes of its JSON, counting bytes, not characters", () => {
    expect(searchProblemWith(search("big", { notes: { "@seyi/a.md": "x".repeat(199_000) } }))).toBeNull();
    expect(searchProblemWith(search("big", { notes: { "@seyi/a.md": "x".repeat(200_000) } }))).toMatch(/200000 bytes/);
    expect(searchProblemWith(search("big", { notes: { "@seyi/a.md": "é".repeat(120_000) } }))).toMatch(/bytes/);
  });

  it("counts cases and kinds with no words, no ids and no queries", () => {
    const cases = [search("case-one", { query: "secret lease words" }), search("case-two", { kind: undefined, query: "ferry words" })];
    const counted = searchCounts(cases);
    expect(counted).toEqual({ cases: 2, byKind: { lease: 1, none: 1 } });
    const text = JSON.stringify(counted);
    expect(text).not.toMatch(/secret|ferry|words only|Words only/i);
    expect(text).not.toContain("case-one");
  });

  it("passes when the change puts the expected note first as often as main, and fails on a first drop", () => {
    const ids = ["a", "b"];
    const r = (id: string, rank: number | null) => ({ id, rank });
    expect(searchVerdict(ids, [r("a", 1), r("b", 3)], [r("a", 1), r("b", 4)])).toEqual({ pass: true, total: 2, first: 1, mainFirst: 1, top5: 2, mainTop5: 2 });
    // Equal on first passes even when the top five moves.
    expect(searchVerdict(ids, [r("a", 1), r("b", 9)], [r("a", 1), r("b", 2)])).toMatchObject({ pass: true, first: 1, mainFirst: 1, top5: 1, mainTop5: 2 });
    // A first drop fails, whatever the top five does.
    const dropped = searchVerdict(ids, [r("a", 2), r("b", 1)], [r("a", 1), r("b", 1)]);
    expect(dropped).toMatchObject({ pass: false, first: 1, mainFirst: 2 });
    expect(searchVerdict(ids, [r("a", 2), r("b", 3)], [r("a", 1), r("b", 1)])).toMatchObject({ pass: false, first: 0, mainFirst: 2 });
  });

  it("counts a missing answer as a miss, and an empty set as a pass with no total", () => {
    expect(searchVerdict(["a"], [], [{ id: "a", rank: 1 }])).toMatchObject({ pass: false, first: 0, mainFirst: 1 });
    expect(searchVerdict(["a"], [{ id: "a", rank: null }], [{ id: "a", rank: null }])).toMatchObject({ pass: true, first: 0, mainFirst: 0 });
    // An answer for a case the run was not handed scores nothing.
    expect(searchVerdict(["a"], [{ id: "z", rank: 1 }], [])).toMatchObject({ first: 0, pass: true });
    expect(searchVerdict([], [], [])).toEqual({ pass: true, total: 0, first: 0, mainFirst: 0, top5: 0, mainTop5: 0 });
  });
});
