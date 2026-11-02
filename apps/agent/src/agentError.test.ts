/**
 * A throw nothing above us logs (an alarm stage, a workflow step) is named by site and class, never by its
 * message, then throws on so retries are unchanged (`agentError.ts`, 2026-11-01).
 * Sabotage: log `error.message` and "never the message" fails; swallow the throw and "throws on" fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorName, logged } from "./agentError";
import { jobTag } from "./jobs";

afterEach(() => vi.restoreAllMocks());

describe("agent errors in the logs", () => {
  it("names the site and the class, never the message, and throws on", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const secret = "Ada +15555550101 said the divorce note";
    await expect(logged("alarm_group", async () => { throw new TypeError(secret); })).rejects.toThrow(secret);
    const lines = logs.mock.calls.flat().map((line) => String(line));
    expect(lines).toEqual([JSON.stringify({ event: "agent_error", where: "alarm_group", name: "TypeError" })]);
    expect(lines.join(" ")).not.toContain("Ada");
  });

  it("returns the work's value and logs nothing when it succeeds", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await logged("job_pass", async () => 7)).toBe(7);
    expect(logs).not.toHaveBeenCalled();
  });

  it("a class name that isn't an identifier, or a thrown non-Error, is never printed as given", () => {
    const odd = new Error("x");
    odd.name = "Ada Lovelace +1555";
    expect(errorName(odd)).toBe("Error");
    expect(errorName("a string someone threw")).toBe("thrown");
    expect(errorName(new RangeError("r"))).toBe("RangeError");
  });

  it("a job's tag is short, stable and not its id", () => {
    const id = "6f1c2d3e-0000-4a5b-8c9d-0123456789ab";
    expect(jobTag(id)).toMatch(/^j[0-9a-f]{8}$/);
    expect(jobTag(id)).toBe(jobTag(id));
    expect(jobTag(id)).not.toContain(id.slice(0, 8));
  });
});
