/**
 * A page the scan could not read is not a page that left the site.
 *
 * The scan that follows every save reads each page at the publication
 * clearance. It used to drop every answer that was not a read as if the note
 * were gone, so one failure that says nothing about privacy (a collaboration
 * history that could not be opened, `STORAGE_UNSAFE`) narrowed the page off
 * the site, and, because the note was still there, wiped its copies from every
 * kept version as if `privacy.md` had held it back. Only Publish widens, so
 * the site stayed down: seyi, public-worship and context-lc's homepage lost
 * every page this way, and supa its layout (2026-11-18).
 *
 * Now only `FILE_NOT_FOUND` (missing or held back, one answer below the
 * barrier) is absence; any other refusal fails the scan, which changes nothing.
 *
 * Sabotage: treat every refusal as absence again in `readScanPages`, and both
 * cases here fail.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { readIntoTree } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

vi.setConfig({ testTimeout: 30_000 });

/** Paths whose next batched reads fail with this code, the way a collaboration read that cannot open does. */
const failing = new Map<string, string>();

vi.mock("../functions/lib/fileOps/reading", async (original) => {
  const actual = await original<typeof import("../functions/lib/fileOps/reading")>();
  return {
    ...actual,
    readFiles: async (...args: Parameters<typeof actual.readFiles>) => {
      const results = await actual.readFiles(...args);
      return results.map((result) => {
        const code = failing.get(result.path);
        return code === undefined
          ? result
          : { path: result.path, outcome: "error" as const, code: code as never, message: "refused" };
      });
    },
  };
});

afterEach(() => {
  failing.clear();
  vi.unstubAllGlobals();
});

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const ABOUT = "---\ntitle: About\nnav: 2\n---\n\nAbout the studio\n";
const LAYOUT = "The frame.\n\n```html\n<header class=\"top\">{ site.name }</header>\n<main>{ content }</main>\n```\n";

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

async function rebuild(f: Fixture): Promise<void> {
  await readIntoTree(f.t, f.workspaceId);
  await f.t.action(internal.functions.websites.reconcileWorkspace, { workspaceId: f.workspaceId }).catch(() => false);
}

function releaseBytes(f: Fixture): string {
  return Object.entries(f.backend.snapshot())
    .filter(([key]) => key.startsWith(".context/website/releases/"))
    .map(([, body]) => body)
    .join("\n");
}

describe("a page the scan cannot read stays published", () => {
  test("a storage failure on one page neither unpublishes it nor wipes its copy", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", ABOUT);
    await publish(f);
    expect(await resolve(f, "/about")).toMatchObject({ kind: "page", title: "About" });
    expect(releaseBytes(f)).toContain("About the studio");

    failing.set("website/about.md", "STORAGE_UNSAFE");
    await rebuild(f);
    failing.clear();

    expect(releaseBytes(f)).toContain("About the studio");
    const about = await resolve(f, "/about");
    expect(about).toMatchObject({ kind: "page", title: "About" });
    const home = await resolve(f, "/");
    expect(home.kind === "page" ? home.navigation.map((item) => item.routePath) : []).toEqual(["/", "/about"]);
  });

  test("a site's layout that cannot be read keeps its frame", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/layout.html.md", LAYOUT);
    await publish(f);
    const rows = async () =>
      (await f.t.run((ctx) => ctx.db.query("websiteRouteIndex").collect()))
        .filter((row) => row.status === "live")
        .map((row) => row.objectKey)
        .sort();
    expect(await rows()).toEqual(["website/index.md", "website/layout.html.md"]);

    failing.set("website/layout.html.md", "STORAGE_UNSAFE");
    await rebuild(f);

    expect(await rows()).toEqual(["website/index.md", "website/layout.html.md"]);
  });
});
