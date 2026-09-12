import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  ROUTE_SEGMENTS,
  redactTelemetryText,
  redactTelemetryValue,
  telemetryRoute,
} from "../features/observability/privacy";
import { cleanPostHogProperties } from "../features/observability/runtime.web";

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

  test("keeps PostHog's required public routing token without preserving user tokens", () => {
    const snapshot = { type: 2, data: { node: "already recorder-masked" } };
    const clean = cleanPostHogProperties(
      {
        token: "stale-or-tampered",
        provider: "dropbox",
        nested: { token: "customer-secret" },
        $snapshot_data: snapshot,
      },
      "public-project-key",
    );

    expect(clean).toEqual({
      provider: "dropbox",
      nested: { token: "[redacted]" },
      token: "public-project-key",
      $snapshot_data: snapshot,
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

  /**
   * `/note/@slug/<path>` IS A REAL ROUTE AND IT CARRIES A NOTE PATH.
   *
   * `client.ts` states the rule two lines under `trackScreen`: "Never send
   * email, note path, context slug or name." `telemetryRoute` enumerated the
   * three prefixes known to be sensitive when it was written, and
   * `app/note/[...address].tsx` — the link format anything outside the app can
   * produce — is not one of them. Its pathname therefore reached PostHog as a
   * `$screen_name`, reached Sentry as a navigation breadcrumb, and on web
   * reached `$current_url` on every event via `sanitizedCurrentUrl`, carrying
   * the context handle and the note's full path with it.
   *
   * A filename is the note's title, which is most of what a note discloses
   * without its body. The fix is the shape rather than the case: a segment is
   * kept only if it is a route name this app actually has, so the next dynamic
   * route is low-cardinality by default instead of by somebody remembering.
   */
  test("a note link's address does not become an analytics event", () => {
    const route = telemetryRoute("/note/@supa/1-projects/2026-pay-review.md");
    expect(route).not.toContain("supa");
    expect(route).not.toContain("1-projects");
    expect(route).not.toContain("pay-review");
    expect(route.startsWith("/note/")).toBe(true);
  });

  test("a note link's address does not survive in a diagnostic string", () => {
    const clean = redactTelemetryText(
      "failed to open /note/@supa/1-projects/2026-pay-review.md",
    );
    expect(clean).not.toContain("supa");
    expect(clean).not.toContain("pay-review");
  });

  test("an unknown segment is replaced even where no rule names it", () => {
    // A meeting id is an identifier, and the floor has to hold for a route
    // nobody wrote a case for — which is every route added after this one.
    expect(telemetryRoute("/meetings/kx7a9c3")).not.toContain("kx7a9c3");
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

  /**
   * THE ALLOWLIST IS ONLY A BOUNDARY WHILE IT MATCHES THE ROUTE TREE.
   *
   * A static route missing from `ROUTE_SEGMENTS` is not a leak — it degrades to
   * `:value` and the telemetry is merely blunter. The failure this guards is
   * the one that already happened once: somebody adds a route, nobody adds a
   * case, and the new route's values travel. Walking `app/` makes adding a
   * route the moment this list is wrong, rather than the moment it leaks.
   */
  test("every static route segment is named in the allowlist", () => {
    const root = join(__dirname, "../app");
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = entry.name;
        // Expo Router: `(group)` is not a URL segment, `[param]` is the value
        // this whole module exists to replace, and `_layout`/`+not-found`/
        // `index` never appear in a pathname on their own.
        if (name.startsWith("(") || name.startsWith("[") || name.startsWith("_")) {
          if (entry.isDirectory()) walk(join(dir, name));
          continue;
        }
        if (name.startsWith("+")) continue;
        if (entry.isDirectory()) {
          found.add(name);
          walk(join(dir, name));
          continue;
        }
        const base = name.replace(/\.[jt]sx?$/, "");
        if (base !== "index") found.add(base);
      }
    };
    walk(root);

    // Non-vacuity: the walk really found the tree, not an empty directory.
    expect(found.has("console")).toBe(true);
    expect(found.size).toBeGreaterThan(10);
    expect([...found].filter((segment) => !ROUTE_SEGMENTS.has(segment))).toEqual([]);
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
