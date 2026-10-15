/**
 * The Dropbox-backed suite, split from `worker.test.ts` to keep each file under the review threshold.
 */
import { describe, expect, it } from "vitest";
import { R2Store } from "../../../apps/mcp/src/store/r2.js";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";
import { REFUSAL } from "./refusal";
import {
  run,
  offlineGuards,
} from "./workerHarness.test-helpers";

const guards = offlineGuards();

/**
 * A Dropbox-backed context receives mail too.
 *
 * The bug this pins: `storeFor` was a hand-rolled subset of the gateway's
 * store factory that only knew `r2-binding` and S3-shaped credentials. A
 * Dropbox binding fell through to the S3 field check, failed it, and every
 * message to that context bounced as `storage_unavailable` — found live on
 * 2026-08-28 when agent@context.lc (Dropbox) bounced while seyi@context.lc
 * (R2) captured, both through the same deployed Worker. The factory in
 * apps/mcp/src/store/factory.js exists precisely so no switch forgets a
 * backend; `storeFor` now delegates to it, and this suite is what fails if
 * anyone hand-rolls the switch again.
 */
describe("a Dropbox-backed context", () => {
  const DROPBOX_BINDING = {
    workspaceId: "ws-1",
    provider: "dropbox",
    accessToken: "short-lived-token",
    capabilities: { conditionalWrite: true },
    status: "active",
  };

  /** A fake of the two content endpoints the capture path touches. */
  function dropboxApi() {
    const uploads: Array<{ path: string; body: string }> = [];
    guards.fetchSpy.mockImplementation(async (url: unknown, init: unknown) => {
      const target = String(url);
      const request = init as { headers: Record<string, string>; body?: Uint8Array };
      if (target.endsWith("/files/download")) {
        // Dropbox says "no such path" as a tagged 409, never a 404 — and the
        // tag is the part that decides. This fixture carried only the
        // `error_summary` line, which satisfied a `String.includes` over the
        // raw body and nothing else; an adapter reading the actual tag saw no
        // tag at all and treated a missing file as a hard failure, so every
        // capture refused. The nested union below is what Dropbox sends.
        return new Response(
          JSON.stringify({
            error_summary: "path/not_found/.",
            error: { ".tag": "path", path: { ".tag": "not_found" } },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target.endsWith("/files/upload")) {
        const arg = JSON.parse(request.headers["Dropbox-API-Arg"]) as { path: string };
        uploads.push({
          path: arg.path,
          body: new TextDecoder().decode(request.body ?? new Uint8Array()),
        });
        return new Response(JSON.stringify({ rev: "015a2b3c4d5e6f", path_display: arg.path }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected call from DropboxStore: ${target}`);
    });
    return uploads;
  }

  it("captures instead of bouncing", async () => {
    const uploads = dropboxApi();
    const { observed } = await run(rawMessage(), { stub: { binding: DROPBOX_BINDING } });
    expect(observed.rejected).toEqual([]);
    const paths = uploads.map((upload) => upload.path);
    expect(paths.filter((path) => path.startsWith("/0-inbox/email/"))).toHaveLength(1);
    expect(paths.filter((path) => path.startsWith("/.context/audit/"))).toHaveLength(1);
  });

  it("writes inside the folder the customer chose, and nowhere else", async () => {
    // The `rootPrefix` seam, which the tests above do not reach because their
    // binding has none. It matters more here than on any other backend: an S3
    // credential is scoped to a bucket holding nothing but this context, so the
    // prefix is a convenience, while a Dropbox token is scoped to an ACCOUNT.
    // That makes this seam the only thing between an ingested note and the rest
    // of somebody's Dropbox.
    const uploads = dropboxApi();
    const { observed } = await run(rawMessage(), {
      stub: { binding: { ...DROPBOX_BINDING, rootPrefix: "Context" } },
    });
    expect(observed.rejected).toEqual([]);
    const paths = uploads.map((upload) => upload.path);
    // Not vacuous: assert something was written before asserting where.
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith("/Context/")).toBe(true);
  });

  it("still refuses a token-less binding, with the one frozen string", async () => {
    const { observed } = await run(rawMessage(), {
      stub: { binding: { ...DROPBOX_BINDING, accessToken: undefined } },
    });
    expect(observed.rejected).toEqual([REFUSAL]);
    expect(guards.fetchSpy).not.toHaveBeenCalled();
  });
});
