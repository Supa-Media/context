import { describe, expect, it } from "vitest";
import { pollOf, withoutPollMark } from "./sendPoll";
import { withoutEffects } from "./sendEffect";

describe("sendPoll: Tex's own iMessage polls", () => {
  it("reads a text that starts \"(poll)\" with one choice per line as a poll", () => {
    expect(pollOf("(poll) Dinner Friday?\n- Thai\n- Pizza\n- Tacos")).toEqual({ title: "Dinner Friday?", choices: ["Thai", "Pizza", "Tacos"] });
    expect(pollOf("(Poll) Which day?\n1. Sat\n2) Sun")).toEqual({ title: "Which day?", choices: ["Sat", "Sun"] });
    expect(pollOf("(poll) Same?\n- a\n- a\n- b")).toEqual({ title: "Same?", choices: ["a", "b"] });
  });

  it("is no poll without the mark, a title, two choices, or with words that are not a choice", () => {
    expect(pollOf("Dinner Friday?\n- Thai\n- Pizza")).toBeNull();
    expect(pollOf("(poll)\n- Thai\n- Pizza")).toBeNull();
    expect(pollOf("(poll) Dinner?\n- Thai")).toBeNull();
    expect(pollOf("(poll) Dinner?\n- Thai\nor anything else\n- Pizza")).toBeNull();
    expect(pollOf(`(poll) Too many?\n${Array.from({ length: 13 }, (_, i) => `- o${i}`).join("\n")}`)).toBeNull();
  });

  it("a line with no polls sends the list without the mark", async () => {
    expect(withoutPollMark("(poll) Dinner?\n- Thai\n- Pizza")).toBe("Dinner?\n- Thai\n- Pizza");
    const sent: string[] = [];
    const line = withoutEffects({ sendText: async (_where: string, text: string) => (sent.push(text), "h") });
    await line.sendText("chat", "(poll) Dinner?\n- Thai\n- Pizza");
    expect(sent).toEqual(["Dinner?\n- Thai\n- Pizza"]);
  });
});
