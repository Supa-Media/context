import { describe, expect, it } from "vitest";
import { effectOf, withoutEffects } from "./sendEffect";

describe("sendEffect: Tex's own iMessage effects", () => {
  it("reads a leading mark by the name Messages shows, in any case, as the bridge's name", () => {
    expect(effectOf("(sent with Slam) WE GOT THE VENUE")).toEqual({ text: "WE GOT THE VENUE", effect: "slam", mark: 17 });
    expect(effectOf("(sent with invisible ink) Friday")).toMatchObject({ text: "Friday", effect: "invisible" });
    expect(effectOf("(sent with Love) miss you")).toMatchObject({ text: "miss you", effect: "heart" });
  });

  it("takes off a mark it cannot send, but sends no effect for it", () => {
    expect(effectOf("(sent with Celebration) done")).toEqual({ text: "done", mark: 24 });
  });

  it("leaves other words alone: a mark mid-text, an unknown name, a mark with nothing after it", () => {
    expect(effectOf("ok (sent with Slam) done")).toEqual({ text: "ok (sent with Slam) done", mark: 0 });
    expect(effectOf("(sent with care) your list")).toEqual({ text: "(sent with care) your list", mark: 0 });
    expect(effectOf("(sent with Slam)")).toEqual({ text: "(sent with Slam)", mark: 0 });
    expect(effectOf("plain words")).toEqual({ text: "plain words", mark: 0 });
  });

  it("a line with no effects sends the words without the mark", async () => {
    const sent: string[] = [];
    const line = withoutEffects({ sendText: async (_where: string, text: string) => (sent.push(text), "h") });
    expect(await line.sendText("chat", "(sent with Confetti) happy birthday")).toBe("h");
    expect(sent).toEqual(["happy birthday"]);
  });
});
