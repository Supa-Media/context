import { describe, expect, test } from "vitest";
import { isServedProvider } from "../../functions/lib/storage/shapes";

describe("served providers", () => {
  test("only the four bucket providers are served; an unknown provider is not", () => {
    expect(isServedProvider("r2")).toBe(true);
    expect(isServedProvider("s3")).toBe(true);
    expect(isServedProvider("b2")).toBe(true);
    expect(isServedProvider("s3-compatible")).toBe(true);
    expect(isServedProvider("retired-provider")).toBe(false);
    expect(isServedProvider("")).toBe(false);
  });
});
