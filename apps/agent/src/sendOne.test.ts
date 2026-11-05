import { describe, expect, it } from "vitest";
import { sendPicturePart, sendWords, type PartLine, type PartLogged } from "./sendOne";
import { PICTURE_FAILED } from "./outgoing";

type Fake = PartLine<string> & { texts: Array<[string, boolean]>; logged: Array<[PartLogged, boolean]>; kept: string[] };

function fakeLine(picture: (p: string) => Promise<string | undefined | null> = async (p) => p, refused = (_: unknown) => true): Fake {
  const texts: Array<[string, boolean]> = [];
  const logged: Array<[PartLogged, boolean]> = [];
  const kept: string[] = [];
  return {
    texts,
    logged,
    kept,
    sendText: async (text, failure) => (texts.push([text, failure]), `h${texts.length}`),
    sendPicture: picture,
    refused,
    remember: async (handle) => void (handle && kept.push(handle)),
    log: async (part, system) => void logged.push([part, system]),
  };
}

describe("one sender (sendOne.ts)", () => {
  it("sends a text, keeps its handle and logs it as the turn's", async () => {
    const line = fakeLine();
    expect(await sendWords(line, "On it.")).toBe(true);
    expect(line.texts).toEqual([["On it.", false]]);
    expect(line.kept).toEqual(["h1"]);
    expect(line.logged).toEqual([[{ kind: "text", text: "On it.", delivered: true }, false]]);
  });

  it("never sends a control word", async () => {
    const line = fakeLine();
    expect(await sendWords(line, "SKIP")).toBe(false);
    expect(line.texts).toEqual([]);
    expect(line.logged).toEqual([]);
  });

  it("logs a sent picture by its address", async () => {
    const line = fakeLine();
    expect(await sendPicturePart(line, "https://example.test/a.png")).toBe(true);
    expect(line.logged).toEqual([[{ kind: "picture", text: "https://example.test/a.png", delivered: true }, false]]);
    expect(line.texts).toEqual([]);
  });

  it("a refused picture is logged undelivered and said once, the line logged as the system's", async () => {
    const line = fakeLine(async () => {
      throw Object.assign(new Error("no"), { status: 400 });
    });
    expect(await sendPicturePart(line, "x")).toBe(false);
    expect(line.texts).toEqual([[PICTURE_FAILED, true]]);
    expect(line.kept).toEqual(["h1"]);
    expect(line.logged).toEqual([
      [{ kind: "picture", delivered: false, reason: "send_refused" }, false],
      [{ kind: "text", text: PICTURE_FAILED, delivered: true }, true],
    ]);
  });

  it("a picture that never uploaded is said the same way", async () => {
    const line = fakeLine(async () => null);
    expect(await sendPicturePart(line, "x")).toBe(false);
    expect(line.logged[0]).toEqual([{ kind: "picture", delivered: false, reason: "upload_failed" }, false]);
    expect(line.logged[1]).toEqual([{ kind: "text", text: PICTURE_FAILED, delivered: true }, true]);
  });

  it("an upload failure standing in the answer as words goes the same way", async () => {
    const line = fakeLine();
    expect(await sendWords(line, PICTURE_FAILED)).toBe(true);
    expect(line.texts).toEqual([[PICTURE_FAILED, true]]);
    expect(line.logged.map(([part, system]) => [part.kind, part.delivered, system])).toEqual([
      ["picture", false, false],
      ["text", true, true],
    ]);
  });

  it("a failure that is not a refusal throws, so the reply is retried", async () => {
    const line = fakeLine(
      async () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      () => false,
    );
    await expect(sendPicturePart(line, "x")).rejects.toThrow("down");
    expect(line.texts).toEqual([]);
    expect(line.logged).toEqual([]);
  });
});
