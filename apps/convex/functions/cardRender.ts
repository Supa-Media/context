"use node";

/**
 * Drawing a share card's PNG.
 *
 * **The first `"use node"` module in this deployment**, and the reason it has to
 * be one is narrow: satori and resvg are ordinary npm packages that expect a
 * Node runtime, and Convex's default V8 environment has neither `Buffer` nor
 * the module resolution they want. Everything else in `functions/` stays in the
 * default runtime; this file is deliberately the whole of the exception, and it
 * does one thing.
 *
 * ## Why wasm and not the native build
 *
 * `@resvg/resvg-js` is 70× faster on paper and is a **platform binary**: npm
 * installs `resvg-js-darwin-arm64` on the machine this was written on and
 * `resvg-js-linux-x64-gnu` where Convex runs. That difference does not surface
 * until deploy — the wrong architecture installs cleanly and fails in
 * production. `@resvg/resvg-wasm` carries its wasm inside the package with no
 * platform variants at all.
 *
 * Measured, because "70× faster" was the paper claim and it is the opposite way
 * round in practice: **native 1782 ms, wasm 19–25 ms warm.** The native binding
 * rebuilds its font database on every construction; the wasm one does not.
 *
 * ## Where the wasm comes from, and why it is not an import
 *
 * Convex bundles JavaScript; it does not ship a package's non-JS files, so
 * `require.resolve("@resvg/resvg-wasm/index_bg.wasm")` **deploys cleanly and
 * throws at runtime** — verified, not assumed. Base64 in a module is how the
 * font arrives, and that does not scale here: the wasm is 2.4 MB, or 3.15 MB
 * encoded, which is an unreviewable source file and pushes at Convex's module
 * limits.
 *
 * So it lives in Convex file storage, uploaded once by
 * `internal.functions.cardRender.installWasm`, and is fetched on the first
 * render in each isolate. That is a network call inside the render path, which
 * is exactly what `loadAdditionalAsset` below refuses — the difference is that
 * this one is to our own deployment, for a fixed asset, with no attacker-chosen
 * input reaching it.
 *
 * ## What this module must never do
 *
 * **Nothing here may reach the customer's bucket, and nothing here holds a
 * credential.** It takes a title, returns bytes, and has no `ctx` access to
 * anything else. Writing the result is `functions/shareCard.ts`'s job, through
 * the one enumerated credential barrier. Keeping the renderer credential-free
 * is what stops `"use node"` — a runtime with far more surface than the default
 * one — from becoming a second door to a bucket key.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { cardElement, CARD_HEIGHT, CARD_WIDTH } from "./lib/cardArt";
import { onestFont } from "./lib/cardFont/onest";

/**
 * Render a title into a 1200×630 PNG.
 *
 * INTERNAL. There is no public path to this: an endpoint that drew whatever
 * text it was handed would make context.lc an arbitrary-text image generator
 * wearing our own branding, which is a phishing asset rather than a feature.
 * The only caller resolves the title from a share token it looked up itself.
 *
 * Returns bytes rather than writing them, so this stays testable and stays
 * credential-free.
 */
export const renderCard = internalAction({
  args: {
    title: v.string(),
    /**
     * What a folder link's card names beside its own name.
     *
     * Already filtered to what a `team` reader may see and already bounded by
     * `boundPreviewChildren` before it reaches this action — this module draws
     * what it is handed and derives no bound of its own, for the reason the
     * whole file is credential-free: a renderer that re-decided a security
     * question would be a second place for that question to be answered wrong.
     *
     * Optional so every existing caller and every note share is unchanged.
     */
    children: v.optional(v.array(v.string())),
  },
  returns: v.bytes(),
  handler: async (ctx, args): Promise<ArrayBuffer> => {
    // Imported inside the handler, not at module scope. Both packages are
    // `externalPackages` in `convex.json`, and a top-level import of an
    // external package is evaluated on every function *definition* rather than
    // on call — which would put a wasm compile in the deployment's cold path
    // for functions that never render anything.
    const satori = (await import("satori")).default;
    const { initWasm, Resvg } = await import("@resvg/resvg-wasm");

    const storageId = await ctx.runQuery(internal.functions.cardAssets.wasmAsset, {});
    if (storageId === null) {
      throw new Error(
        "the card renderer's wasm is not installed — run internal.functions.cardRender.installWasm",
      );
    }
    await ensureWasm(ctx, initWasm, storageId);

    const svg = await satori(cardElement(args.title, args.children ?? []) as never, {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      fonts: [
        {
          name: "Onest",
          data: onestFont() as unknown as ArrayBuffer,
          weight: 600,
          style: "normal",
        },
      ],
      /**
       * THE LINE. Without it satori goes to the network on a glyph miss —
       * Google Fonts for a fallback face, jsDelivr for Twemoji. That would be a
       * hidden third-party dependency inside a *customer's* render path, note
       * titles sent to two CDNs, latency an attacker chooses (20 ms ASCII,
       * 725 ms Japanese), and a hard crash on Arabic. It also closes an SSRF
       * path: satori 0.29.1 hardened its remote fetcher and this is 0.29.0, so
       * the code is simply never entered.
       *
       * The cost is that an uncovered glyph draws as tofu, which is why the
       * caller checks coverage before asking for a render.
       */
      loadAdditionalAsset: async () => "",
    });

    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: CARD_WIDTH },
    })
      .render()
      .asPng();

    // Copied into a fresh ArrayBuffer rather than handed over as a view:
    // `v.bytes()` wants an ArrayBuffer, and a Uint8Array's underlying buffer
    // can be larger than the view when it comes from a pool.
    return png.buffer.slice(
      png.byteOffset,
      png.byteOffset + png.byteLength,
    ) as ArrayBuffer;
  },
});

/**
 * Compile the wasm once per isolate.
 *
 * `initWasm` throws if it is called twice, and a Convex isolate serves many
 * requests — so the second render in an isolate would fail without this. The
 * promise is cached rather than a boolean so two concurrent renders in a cold
 * isolate await one compile instead of racing into that throw.
 */
let wasmReady: Promise<void> | null = null;

async function ensureWasm(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  initWasm: (mod: Promise<Response> | Response | BufferSource) => Promise<void>,
  storageId: Id<"_storage">,
): Promise<void> {
  wasmReady ??= (async () => {
    const url = await ctx.storage.getUrl(storageId);
    if (url === null) {
      throw new Error(
        "the card renderer's wasm is not installed — run internal.functions.cardRender.installWasm",
      );
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`could not load the card renderer's wasm (${response.status})`);
    }
    await initWasm(await response.arrayBuffer());
  })();
  await wasmReady;
}

/**
 * Put the renderer's wasm in file storage. Run once per deployment.
 *
 * INTERNAL, and takes the bytes as an argument rather than reading them: this
 * runs in the deployment, and the file lives in the repository. `scripts/`
 * hands it over — see `installCardWasm.mjs`.
 *
 * Idempotent by replacement: a second call stores a new object and repoints the
 * row, so a bad upload is fixed by running it again rather than by surgery.
 */
export const installWasm = internalAction({
  /**
   * The wasm arrives in pieces, and that is an argv limit rather than a
   * preference: 2.4 MB of wasm is 3.15 MB of base64, and passing that to
   * `convex run` fails with `E2BIG` — the OS caps a process's arguments at
   * about a megabyte. `convex run` has no stdin form, so the script splits it
   * and this reassembles.
   *
   * `index` and `total` are carried so a truncated install fails loudly:
   * assembling four chunks that arrive as three is a wasm that deploys and
   * throws, which is the failure mode this whole file exists to have already
   * met once.
   */
  args: {
    chunk: v.bytes(),
    index: v.number(),
    total: v.number(),
  },
  returns: v.union(v.null(), v.id("_storage")),
  handler: async (ctx, args): Promise<Id<"_storage"> | null> => {
    const parts = await ctx.runMutation(internal.functions.cardAssets.appendChunk, {
      chunk: args.chunk,
      index: args.index,
      total: args.total,
    });
    // Not the last piece: nothing to store yet.
    if (parts === null) return null;

    const blob = new Blob(parts, { type: "application/wasm" });
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.functions.cardAssets.recordWasm, { storageId });
    return storageId;
  },
});
