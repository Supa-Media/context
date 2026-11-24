/**
 * A note link Tex texted unfurls as the note (Dev, 2026-11-23;
 * `docs/decisions/privacy-and-sharing/note-link-previews.md`).
 *
 * What holds it: `/note/preview` and `/note/card` answer only for a key this
 * deployment's gateway signed over exactly that workspace, path and name, so
 * nobody can make a context.lc card say a name Tex did not text, and a guessed
 * note address tells a stranger nothing. Every refusal is one shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewKey, previewSigningKey } from "@context/shared/src/notePreview.cjs";
import { agentTextsNoteCardHandler } from "../functions/lib/gatewayRoutes/noteCard";
import { noteCardHandler, notePreviewHandler, signedNoteCard } from "../functions/lib/publicRoutes/noteLinkCards";
import { noteCardElement } from "../functions/lib/noteCardArt";

const SECRET = "test-gateway-secret-0123456789";
const LINK = { slug: "seyi", path: "areas/spirit/bible-study/1-timothy-1.md", title: "1 Timothy 1" };
const NULLS = { title: null, description: null, card: null };

async function keyFor(link: { slug: string; path: string; title: string }, secret = SECRET): Promise<string> {
  return previewKey((await previewSigningKey(secret))!, link);
}

const post = (body: unknown) => new Request("https://convex.example/note/preview", { method: "POST", body: JSON.stringify(body) });

function ctxRendering(result: ArrayBuffer | Error = new Uint8Array([137, 80, 78, 71]).buffer) {
  const runAction = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { ctx: { runAction } as never, runAction };
}

beforeEach(() => vi.stubEnv("GATEWAY_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("POST /note/preview", () => {
  it("answers a signed link with its name, its folders and that its card can be drawn", async () => {
    const key = await keyFor(LINK);
    const response = await notePreviewHandler({} as never, post({ ...LINK, key }));
    expect(await response.json()).toEqual({ title: "1 Timothy 1", description: "Spirit · Bible study", card: true });
  });

  it("reads the workspace as the key signs it, in any case", async () => {
    const key = await keyFor(LINK);
    expect(await signedNoteCard({ ...LINK, slug: "Seyi", key })).not.toBeNull();
  });

  it.each([
    ["another name", { title: "1 Timothy 2" }],
    ["another note", { path: "areas/spirit/bible-study/1-timothy-2.md" }],
    ["another workspace", { slug: "sey1" }],
    ["a name with spaces around it", { title: " 1 Timothy 1" }],
  ])("refuses the key on %s", async (_label, change) => {
    const key = await keyFor(LINK);
    const response = await notePreviewHandler({} as never, post({ ...LINK, ...change, key }));
    expect(await response.json()).toEqual(NULLS);
  });

  it("refuses a key another deployment's secret made", async () => {
    const key = await keyFor(LINK, "some-other-secret-0123456789");
    expect(await (await notePreviewHandler({} as never, post({ ...LINK, key }))).json()).toEqual(NULLS);
  });

  it("refuses every key when the deployment has no secret", async () => {
    const key = await keyFor(LINK);
    vi.stubEnv("GATEWAY_SECRET", "");
    expect(await (await notePreviewHandler({} as never, post({ ...LINK, key }))).json()).toEqual(NULLS);
  });

  it.each([
    ["no key", { key: undefined }],
    ["a key of the wrong shape", { key: "short" }],
    ["a forged key", { key: "AAAAAAAAAAAAAAAAAAAAAA" }],
    ["a rooted path", { path: "/areas/a.md" }],
    ["a traversing path", { path: "areas/../a.md" }],
    ["a hidden path", { path: ".context/collaboration/a.md" }],
    ["a path that is not a note", { path: "files/a.png" }],
    ["a malformed workspace", { slug: "../x" }],
    ["a number for a name", { title: 7 }],
  ])("is one null shape for %s", async (_label, change) => {
    const key = await keyFor(LINK);
    const response = await notePreviewHandler({} as never, post({ ...LINK, key, ...change }));
    expect(await response.json()).toEqual(NULLS);
  });

  it("names a note the card faces cannot draw, and says there is no card for it", async () => {
    const link = { slug: "seyi", path: "notes/plan.md", title: "計画" };
    const response = await notePreviewHandler({} as never, post({ ...link, key: await keyFor(link) }));
    expect(await response.json()).toEqual({ title: "計画", description: "Notes", card: false });
  });
});

describe("POST /note/card", () => {
  it("draws a signed link's name, folders, backdrop and pose, and hands back the PNG", async () => {
    const { ctx, runAction } = ctxRendering();
    const response = await noteCardHandler(ctx, post({ ...LINK, key: await keyFor(LINK) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(runAction).toHaveBeenCalledWith(expect.anything(), {
      title: "1 Timothy 1",
      folder: "Spirit · Bible study",
      board: expect.any(String),
      pose: "reading",
    });
  });

  it("draws nothing, and spends no render, for a key that does not hold", async () => {
    const { ctx, runAction } = ctxRendering();
    const response = await noteCardHandler(ctx, post({ ...LINK, title: "Something else", key: await keyFor(LINK) }));
    expect(response.status).toBe(404);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("draws nothing for a name its faces cannot draw", async () => {
    const { ctx, runAction } = ctxRendering();
    const link = { slug: "seyi", path: "notes/plan.md", title: "計画" };
    expect((await noteCardHandler(ctx, post({ ...link, key: await keyFor(link) }))).status).toBe(404);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("answers 404 when the renderer fails", async () => {
    const { ctx } = ctxRendering(new Error("no wasm"));
    expect((await noteCardHandler(ctx, post({ ...LINK, key: await keyFor(LINK) }))).status).toBe(404);
  });
});

describe("the picture Tex texts ahead of a note link", () => {
  it("is the same card when the texting Worker names the note's path", async () => {
    const { ctx, runAction } = ctxRendering();
    const response = await agentTextsNoteCardHandler(ctx, { title: "1 Timothy 1", slug: "seyi", path: LINK.path });
    expect(response.status).toBe(200);
    expect(runAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: "1 Timothy 1", folder: "Spirit · Bible study", pose: "reading" }));
  });

  it("refuses a path that is not a note's", async () => {
    const { ctx, runAction } = ctxRendering();
    expect((await agentTextsNoteCardHandler(ctx, { title: "Plan", slug: "seyi", path: "../x.md" })).status).toBe(404);
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe("the card's layout", () => {
  it("shows Tex only for a pose, and the # tile otherwise", () => {
    const withTex = JSON.stringify(noteCardElement({ title: "Plan", folder: "", board: "ink", pose: "trip" }));
    const plain = JSON.stringify(noteCardElement({ title: "Plan", folder: "", board: "ink", pose: null }));
    expect(withTex).toContain('"width":190');
    expect(plain).toContain('"width":112');
    expect(plain).not.toContain('"width":190');
  });

  it("leaves the folder line off a note at the top, and sets the name in Libron", () => {
    const top = noteCardElement({ title: "Plan", folder: "", board: "paper", pose: null });
    const filed = noteCardElement({ title: "Plan", folder: "Travel", board: "paper", pose: null });
    expect(top.props.children).toHaveLength(3);
    expect(filed.props.children).toHaveLength(4);
    expect(JSON.stringify(top)).toContain('"fontFamily":"Libron"');
  });
});
