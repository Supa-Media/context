import { describe, expect, it } from "vitest";
import { objectName, parseAsk } from "./routes";

const OWNER = "a".repeat(64);

describe("what the gateway may ask of Tex's computer", () => {
  it("takes one of the operations for one owner tag, and hands the rest on", () => {
    expect(parseAsk("POST", "/computer/run", { owner: OWNER, command: "ls" })).toEqual({ op: "run", owner: OWNER, input: { command: "ls" } });
    expect(parseAsk("POST", "/computer/stop", { owner: OWNER })).toEqual({ op: "stop", owner: OWNER, input: {} });
  });

  it("refuses anything that is not a computer's tag, so one request can never name another's object by a chosen name", () => {
    for (const owner of [undefined, "", "alice", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}x`, 42]) {
      expect(parseAsk("POST", "/computer/run", { owner, command: "ls" })).toMatchObject({ status: 400 });
    }
  });

  it("refuses an unknown operation, a GET and a body that is not an object", () => {
    expect(parseAsk("POST", "/computer/shell", { owner: OWNER })).toMatchObject({ status: 404 });
    expect(parseAsk("GET", "/computer/run", null)).toMatchObject({ status: 405 });
    expect(parseAsk("POST", "/computer/run", [OWNER])).toMatchObject({ status: 400 });
  });

  it("names one object per owner", () => {
    expect(objectName(OWNER)).toBe(`computer:${OWNER}`);
    expect(objectName(OWNER)).not.toBe(objectName("b".repeat(64)));
  });
});
