import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `redirect: "error"` is not implemented by workerd.
 *
 * `fetch` rejects with a TypeError *before the request is made*, and
 * `post()` flattens every throw to `ControlPlaneError("request failed")` —
 * deliberately, since the raw error can quote the request including its
 * `Authorization` header. So the Worker reached the control-plane call, threw,
 * and Cloudflare reported only "worker script threw an exception". Every
 * inbound message died there and the cause was invisible for hours.
 *
 * Confirmed by experiment, not inference: with `"error"` the Worker throws
 * `control_plane_unavailable / request failed` under `wrangler dev`; changing
 * only this one option, the same message resolves and proceeds to the auth
 * check. The identical call from node — where `"error"` *is* implemented —
 * succeeds either way, which is why the unit suite never noticed.
 *
 * `"manual"` carries the intent that mattered: a redirect is surfaced as a
 * response rather than followed, and `post()` refuses any status that is not
 * 200 — so a redirected call is still a failed call, and no credential is
 * replayed to a Location we did not choose.
 *
 * This asserts on the source because the behaviour lives in an option value
 * that only a real Workers runtime evaluates; a mocked `fetchImpl` cannot see
 * it, and every existing test uses one.
 */
const RAW = readFileSync(join(__dirname, "controlPlane.ts"), "utf8");

/**
 * Comments stripped before matching.
 *
 * The first version of this test failed on its own explanation: the rationale
 * beside the option names the very string it bans. A guard that reads prose as
 * code is the same defect as the gateway's import check, which once refused a
 * comment containing `from "not yours"`.
 */
const SOURCE = RAW.split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

describe("the control-plane fetch uses options workerd implements", () => {
  it('never asks for redirect: "error"', () => {
    expect(SOURCE).not.toMatch(/redirect:\s*["']error["']/);
  });

  it('asks for redirect: "manual"', () => {
    expect(SOURCE).toMatch(/redirect:\s*["']manual["']/);
  });

  it("still refuses any non-200, so a surfaced redirect is a failure", () => {
    expect(SOURCE).toMatch(/status\s*!==\s*200/);
  });
});
