import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Convex's reload prompt stays off; the console's own guard is the only one.
 *
 * `ConvexReactClient` attaches a `beforeunload` listener by default that asks
 * "Changes you made may not be saved" while any mutation **or action** is
 * still waiting on the server. This app reads notes, listings and folder
 * pages through actions, so that prompt fired on almost every refresh — on a
 * board with nothing unsaved (reported 2026-09-26). Whether leaving loses
 * work is `useUnsavedGuard`'s question, and it asks only for a conflict or a
 * failed save (`unsavedGuards.test.ts`).
 *
 * Structural for the reason `authHandleCode.test.ts` is: the root layout
 * pulls in expo-router's Slot and cannot be mounted here, and the provider
 * forwarding the prop is pinned in supa-framework's own suite.
 */
describe("the root layout turns off Convex's reload prompt", () => {
  const layout = readFileSync(join(__dirname, "..", "app", "_layout.tsx"), "utf8");

  test("SupaConvexProvider receives unsavedChangesWarning={false}", () => {
    expect(layout).toContain("unsavedChangesWarning={false}");
  });

  test("and the provider installed can forward it", () => {
    const provider = readFileSync(
      join(
        dirname(require.resolve("@supa-media/core/providers", { paths: [join(__dirname, "..")] })),
        "ConvexProvider.js",
      ),
      "utf8",
    );
    expect(provider).toMatch(/getClient\(convexUrl, unsavedChangesWarning\)/);
  });
});
