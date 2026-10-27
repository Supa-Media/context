import { describe, expect, it, vi } from "vitest";
import { agentTextsNoteCardHandler } from "../functions/lib/gatewayRoutes/noteCard";
import { CARD_SUBTITLE_TEXTED, cardElement } from "../functions/lib/cardArt";

function ctxRendering(bytes: ArrayBuffer | Error) {
  const runAction = vi.fn(async () => {
    if (bytes instanceof Error) throw bytes;
    return bytes;
  });
  return { ctx: { runAction } as never, runAction };
}

describe("POST /agent-texts/note-card", () => {
  it("draws the note's name and workspace with the texted line, and hands back the PNG", async () => {
    const { ctx, runAction } = ctxRendering(new Uint8Array([137, 80, 78, 71]).buffer);
    const response = await agentTextsNoteCardHandler(ctx, { title: "Launch plan", slug: "seyi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ png: btoa(String.fromCharCode(137, 80, 78, 71)) });
    expect(runAction).toHaveBeenCalledWith(expect.anything(), {
      title: "Launch plan",
      handle: "@seyi",
      kind: "note",
      subtitle: CARD_SUBTITLE_TEXTED,
    });
  });

  it.each([
    [{ title: "", slug: "seyi" }, "no name"],
    [{ title: "Plan", slug: "Not A Slug" }, "a malformed workspace"],
    [{ title: "Plan", slug: "../x" }, "a path for a workspace"],
    [{ title: "計画", slug: "seyi" }, "a name the font cannot draw"],
    [{ slug: "seyi" }, "no title at all"],
  ] as [Record<string, unknown>, string][])("refuses %j (%s) without rendering", async (body) => {
    const { ctx, runAction } = ctxRendering(new ArrayBuffer(1));
    const response = await agentTextsNoteCardHandler(ctx, body);
    expect(response.status).toBe(404);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("answers 404 when the renderer fails, so the link still goes alone", async () => {
    const { ctx } = ctxRendering(new Error("no wasm"));
    expect((await agentTextsNoteCardHandler(ctx, { title: "Plan", slug: "seyi" })).status).toBe(404);
  });
});

describe("the texted card's line", () => {
  it("replaces the share line only when asked", () => {
    const shared = JSON.stringify(cardElement({ title: "Plan", handle: "@seyi", kind: "note", children: [] }));
    const texted = JSON.stringify(cardElement({ title: "Plan", handle: "@seyi", kind: "note", children: [], subtitle: CARD_SUBTITLE_TEXTED }));
    expect(shared).toContain("Shared with you");
    expect(texted).toContain(CARD_SUBTITLE_TEXTED);
    expect(texted).not.toContain("Shared with you");
  });
});
