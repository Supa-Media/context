/**
 * The Speed and cost view's "Measured from a run" reader (`features/tex/lab/views/simLog.ts`). It is the
 * artifact's `readLog` as a pure function: a subscription model is re-timed from its tokens, an API model
 * keeps its logged time, a line of another side is skipped, and a line that is not JSON or names no step
 * of the version is counted as bad.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-13):
 *  1. `readLog` counting `side: "main"` lines as bad → "a main-side line is skipped, not counted as bad" fails.
 *  2. `readLog` timing a subscription model by its logged ms → "a subscription step is re-timed from its tokens" fails.
 */
import { expect, jest, test } from "@jest/globals";
import { BASE_MODELS } from "../features/tex/lab/data/models";
import type { LabGraph } from "../features/tex/lab/types";
import { readLog } from "../features/tex/lab/views/simLog";
jest.mock("../features/tex/lab/data/models", () => jest.requireActual<typeof import("./fixtures/texLabArtifactGraph")>("./fixtures/texLabArtifactGraph").artifactModelsModule());

const g: LabGraph = {
  nodes: [
    { id: "fd", label: "Front door", model: "haiku-5-5" } as LabGraph["nodes"][number],
    { id: "decide", label: "Decide", model: "clef" } as LabGraph["nodes"][number],
  ],
  edges: [],
};

test("a subscription step is re-timed from its tokens, an API step keeps its logged time", () => {
  const r = readLog(
    [
      '{"node":"fd","model":"haiku-5-5","ms":4100,"in":21000,"out":310}',
      '{"node":"decide","model":"clef","ms":900,"in":500,"out":3}',
    ].join("\n"),
    g,
    BASE_MODELS,
  );
  expect(r.bad).toBe(0);
  expect(r.matched).toBe(2);
  const fd = r.rows!.fd;
  expect(fd.api).toBe(false);
  expect(fd.calls).toBe(1);
  expect(fd.wall).toBe(4100);
  expect(fd.out).toBe(310);
  // base 1400 + 310 * 4.1 + 21000 * 0.2 * 0.006
  expect(fd.prodMs).toBeCloseTo(1400 + 310 * 4.1 + 21000 * 0.2 * 0.006, 6);
  const dec = r.rows!.decide;
  expect(dec.api).toBe(true);
  expect(dec.prodMs).toBe(900);
});

test("calls of one step add up", () => {
  const r = readLog('{"node":"fd","model":"haiku-5-5","ms":1000,"out":10}\n{"node":"fd","model":"haiku-5-5","ms":2000,"out":20}', g, BASE_MODELS);
  expect(r.rows!.fd.calls).toBe(2);
  expect(r.rows!.fd.wall).toBe(3000);
  expect(r.rows!.fd.out).toBe(30);
});

test("a line that is not JSON, or names no step of the version, is counted as bad", () => {
  const r = readLog(['{"node":"fd","model":"haiku-5-5","ms":1000}', "not json", '{"node":"nope","ms":5}', "42"].join("\n"), g, BASE_MODELS);
  expect(r.matched).toBe(1);
  expect(r.bad).toBe(3);
  expect(Object.keys(r.rows!)).toEqual(["fd"]);
});

test("a main-side line is skipped, not counted as bad", () => {
  const r = readLog('{"side":"main","node":"fd","model":"haiku-5-5","ms":1000}\n{"side":"main","node":"nope"}\n{"node":"fd","model":"haiku-5-5","ms":500}', g, BASE_MODELS);
  expect(r.bad).toBe(0);
  expect(r.matched).toBe(1);
  expect(r.rows!.fd.calls).toBe(1);
  expect(r.rows!.fd.wall).toBe(500);
});

test("no matching line gives no rows and a zero count", () => {
  const r = readLog('{"side":"main","node":"fd"}\n\n   ', g, BASE_MODELS);
  expect(r.rows).toBeNull();
  expect(r.matched).toBe(0);
  expect(r.bad).toBe(0);
});

test("a line's model is used when given, the step's model otherwise", () => {
  const r = readLog('{"node":"decide","ms":700}', g, BASE_MODELS);
  // decide's step model is clef (API), so the logged time is kept.
  expect(r.rows!.decide.prodMs).toBe(700);
  const s = readLog('{"node":"fd","model":"clef","ms":700}', g, BASE_MODELS);
  expect(s.rows!.fd.api).toBe(true);
});
