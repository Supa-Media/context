import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { type Fixture, fixture, share } from "./fixtures.helpers";

/**
 * The image proxy: a remote image a note names, fetched by the server so the
 * reader's own browser never contacts its host.
 *
 * What has to hold: it is not an open proxy (the URL must be in a note the
 * caller can see, and every other case is the same `FILE_NOT_FOUND` as a note
 * that does not exist); the request carries nothing about the reader; and the
 * bytes decide the type, so an SVG or a page served as `image/png` is refused.
 */

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0xff, 0x01]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

/** Serve `routes` for `img.example`, and send everything else to the fixture's bucket. */
function serve(f: Fixture, routes: Record<string, () => Response>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://img.example/") || url.startsWith("http://img.example/")) {
      seen.push({ url, init });
      const route = routes[url];
      return Promise.resolve(route ? route() : new Response("missing", { status: 404 }));
    }
    return f.backend.fetchImpl(input as RequestInfo, init);
  });
  return seen;
}

async function rewrite(f: Fixture, path: string, text: string): Promise<void> {
  const existing = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
    workspaceId: f.workspaceId,
    path,
  });
  await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
    workspaceId: f.workspaceId,
    path,
    text,
    expectedEtag: existing.etag,
  });
}

describe("the image proxy", () => {
  test("draws a remote image a visible note names, and the request says nothing about the reader", async () => {
    const f = await fixture();
    await rewrite(f, "1-projects/shared.md", "# Shared\n\n![logo](https://img.example/logo.png)\n");
    const seen = serve(f, {
      "https://img.example/logo.png": () =>
        new Response(PNG, { status: 200, headers: { "content-type": "text/html" } }),
    });
    const read = await asUser(f.t, f.owner).action(api.functions.files.readRemoteImage, {
      workspaceId: f.workspaceId,
      notePath: "1-projects/shared.md",
      url: "https://img.example/logo.png",
    });
    expect(new Uint8Array(read.bytes)).toEqual(PNG);
    // The type is the bytes', not the server's `text/html`.
    expect(read.contentType).toBe("image/png");
    expect(seen).toHaveLength(1);
    expect(seen[0].init?.credentials).toBe("omit");
    const headers = new Headers(seen[0].init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("referer")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  test("is not an open proxy: a URL no note names fetches nothing", async () => {
    const f = await fixture();
    const seen = serve(f, { "https://img.example/anything.png": () => new Response(PNG) });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.readRemoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        url: "https://img.example/anything.png",
      }),
    );
    expect(errorCode(error)).toBe("FILE_NOT_FOUND");
    expect(seen).toHaveLength(0);
  });

  test("a member cannot use a private note's URL, and learns nothing about it", async () => {
    const f = await fixture();
    await share(f);
    await rewrite(f, "2-areas/private-note.md", "# Private\n\n![](https://img.example/private.png)\n");
    const seen = serve(f, { "https://img.example/private.png": () => new Response(PNG) });
    const throughThePrivateNote = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.readRemoteImage, {
        workspaceId: f.workspaceId,
        notePath: "2-areas/private-note.md",
        url: "https://img.example/private.png",
      }),
    );
    const throughAVisibleNote = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.readRemoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        url: "https://img.example/private.png",
      }),
    );
    expect(errorCode(throughThePrivateNote)).toBe("FILE_NOT_FOUND");
    expect(errorCode(throughAVisibleNote)).toBe("FILE_NOT_FOUND");
    expect(seen).toHaveLength(0);
  });

  test("a stranger reaches nothing", async () => {
    const f = await fixture();
    await rewrite(f, "1-projects/shared.md", "![](https://img.example/logo.png)\n");
    const seen = serve(f, { "https://img.example/logo.png": () => new Response(PNG) });
    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.readRemoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        url: "https://img.example/logo.png",
      }),
    );
    expect(errorCode(error)).not.toBeNull();
    expect(seen).toHaveLength(0);
  });

  test.each([
    ["an SVG, whatever it is served as", "https://img.example/x.svg", () => new Response(SVG, { headers: { "content-type": "image/png" } })],
    ["a page served as an image", "https://img.example/page.png", () => new Response("<html></html>", { headers: { "content-type": "image/png" } })],
    ["a redirect down to http", "https://img.example/down.png", () => new Response(null, { status: 302, headers: { location: "http://img.example/logo.png" } })],
    ["an image over the ceiling", "https://img.example/huge.png", () => new Response(new Uint8Array(5_000_001))],
  ])("refuses %s", async (_label, url, respond) => {
    const f = await fixture();
    await rewrite(f, "1-projects/shared.md", `![](${url})\n`);
    serve(f, { [url]: respond });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.readRemoteImage, {
        workspaceId: f.workspaceId,
        notePath: "1-projects/shared.md",
        url,
      }),
    );
    expect(errorCode(error)).toBe("REMOTE_IMAGE_UNAVAILABLE");
  });

  test("never fetches plain http or an address, even when a note names one", async () => {
    const f = await fixture();
    await rewrite(
      f,
      "1-projects/shared.md",
      "![](http://img.example/logo.png) ![](https://127.0.0.1/logo.png) ![](https://localhost/logo.png)\n",
    );
    const seen = serve(f, {});
    for (const url of ["http://img.example/logo.png", "https://127.0.0.1/logo.png", "https://localhost/logo.png"]) {
      const error = await captureError(() =>
        asUser(f.t, f.owner).action(api.functions.files.readRemoteImage, {
          workspaceId: f.workspaceId,
          notePath: "1-projects/shared.md",
          url,
        }),
      );
      expect(errorCode(error)).toBe("REMOTE_IMAGE_UNAVAILABLE");
    }
    expect(seen).toHaveLength(0);
  });
});
