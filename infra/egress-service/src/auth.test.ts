import { describe, expect, it } from "vitest";
import { isAuthorized } from "./auth";

describe("the service credential", () => {
  it("accepts only the exact configured bearer secret", async () => {
    await expect(isAuthorized("Bearer test-secret", "test-secret")).resolves.toBe(true);
    for (const header of [null, "", "test-secret", "Basic test-secret", "Bearer wrong", "Bearer test-secret extra"]) {
      await expect(isAuthorized(header, "test-secret")).resolves.toBe(false);
    }
  });

  it("fails closed when the deployment secret is absent", async () => {
    for (const secret of [undefined, "", "   "]) {
      await expect(isAuthorized("Bearer test-secret", secret)).resolves.toBe(false);
    }
  });
});
