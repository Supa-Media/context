import { describe, expect, test } from "@jest/globals";
import { CLIENT_PROVIDERS } from "../features/console/clients/providers";
import { TELL_CHAIN, TELL_NAMES, tellPair, tellSentence, tellSteps } from "../features/landing/tell";

/**
 * The landing pages' headline, "Tell Claude. ChatGPT already knows.", and the
 * retyping that walks it through the AIs (`features/landing/tell.ts`). What
 * the page claims has to stay true: every name is a client Context connects
 * today, and no frame the page holds still says something odd.
 */

describe("the landing headline", () => {
  test("names only AIs Context connects today", () => {
    const connected = new Set(CLIENT_PROVIDERS.map((p) => p.name));
    for (const ai of TELL_CHAIN) {
      const name = TELL_NAMES[ai];
      expect([...connected].some((c) => c === name || c.startsWith(`${name} `))).toBe(true);
    }
  });

  test("a screen reader hears the first sentence, which is the one the page opens on", () => {
    expect(tellSentence(0)).toBe("Tell Claude. ChatGPT already knows.");
    const first = tellSteps(0)[0].slots;
    expect(first.map((s) => s.ai)).toEqual(tellPair(0));
  });

  test("never tells an AI what it already knows", () => {
    for (let i = 0; i < TELL_CHAIN.length * 2; i += 1) {
      const [told, knows] = tellPair(i);
      expect(told).not.toBe(knows);
    }
  });

  test("every whole sentence on the way is a true one: two different AIs, nothing half typed", () => {
    for (let i = 0; i < TELL_CHAIN.length; i += 1) {
      for (const { slots } of tellSteps(i)) {
        const whole = slots.every((s) => s.typed === TELL_NAMES[s.ai].length);
        if (whole) expect(slots[0].ai).not.toBe(slots[1].ai);
      }
    }
  });

  test("ends on the next pair with no caret left behind, so the loop joins up", () => {
    for (let i = 0; i < TELL_CHAIN.length; i += 1) {
      const steps = tellSteps(i);
      const last = steps[steps.length - 1].slots;
      expect(last.map((s) => s.ai)).toEqual(tellPair(i + 1));
      expect(last.some((s) => s.caret)).toBe(false);
      expect(tellSteps(i + 1)[0].slots).toEqual(last);
    }
  });

  test("backspaces a name in its own colour and types the next in the new one", () => {
    const steps = tellSteps(0).map((s) => s.slots[1]);
    const erasing = steps.filter((s) => s.ai === "chatgpt" && s.caret);
    const typing = steps.filter((s) => s.ai === "cursor" && s.caret);
    expect(erasing.map((s) => s.typed)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(typing.map((s) => s.typed)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
