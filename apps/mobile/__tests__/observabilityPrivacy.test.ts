import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  redactTelemetryText,
  redactTelemetryValue,
  telemetryRoute,
} from "../features/observability/privacy";

describe("observability privacy boundary", () => {
  test("removes OAuth credentials and capability tokens", () => {
    const input =
      "https://context.lc/connect/google?code=secret-code&token=secret-token /invite/unguessable";
    const clean = redactTelemetryText(input);
    expect(clean).not.toContain("secret-code");
    expect(clean).not.toContain("secret-token");
    expect(clean).not.toContain("unguessable");
    expect(clean).toContain("code=[redacted]");
    expect(clean).toContain("/invite/:token");
  });

  test("redacts sensitive keys recursively without deleting useful diagnostics", () => {
    expect(
      redactTelemetryValue({
        status: 401,
        request: { authorization: "Bearer abc", url: "/s/abc123" },
        noteContent: "the private note",
      }),
    ).toEqual({
      status: 401,
      request: { authorization: "[redacted]", url: "/s/:token" },
      noteContent: "[redacted]",
    });
  });

  test("removes identities and context handles from diagnostic strings", () => {
    const clean = redactTelemetryText(
      "member seyi@example.com failed while opening /console/@private-team/settings",
    );
    expect(clean).toBe(
      "member [redacted-email] failed while opening /console/:context/settings",
    );
  });

  test.each([
    ["/", "/"],
    ["/console/@supa", "/console/:context"],
    ["/console/@supa/settings", "/console/:context/settings"],
    ["/invite/a-real-capability", "/invite/:token"],
    ["/s/a-share-capability", "/s/:token"],
    ["/connect/google", "/connect/google"],
  ])("normalizes route %s", (path, expected) => {
    expect(telemetryRoute(path)).toBe(expected);
  });

  test("keeps native replay off until rendered text can be globally masked", () => {
    const runtime = readFileSync(
      join(__dirname, "../features/observability/runtime.ts"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "../package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(runtime).toContain("enableSessionReplay: false");
    expect(manifest.dependencies["@posthog/react-native-plugin"]).toBeUndefined();
  });
});
