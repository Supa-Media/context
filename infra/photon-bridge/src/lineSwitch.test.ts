import { describe, expect, it } from "vitest";
import { lineOn } from "./lineSwitch";

const KEYS = { PHOTON_PROJECT_ID: "p", PHOTON_PROJECT_SECRET: "s" };

describe("lineOn", () => {
  it("runs the line with the project's credentials", () => {
    expect(lineOn(KEYS)).toBe(true);
  });

  it("never runs it where the deployment turns it off, credentials or not", () => {
    expect(lineOn({ ...KEYS, PHOTON_LINE: "off" })).toBe(false);
    expect(lineOn({ ...KEYS, PHOTON_LINE: " off " })).toBe(false);
  });

  it("never runs it without both credentials", () => {
    expect(lineOn({ PHOTON_PROJECT_ID: "p" })).toBe(false);
    expect(lineOn({})).toBe(false);
  });
});
