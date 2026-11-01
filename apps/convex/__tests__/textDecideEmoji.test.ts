/**
 * Decide picks the reaction emoji from a curated 64 and may say "wait" for a
 * burst still being typed (Dev2, 2026-10-27; `functions/lib/reactEmoji.ts`).
 *
 * Sabotage (temporary local edits, reverted):
 *  - returning the emoji with any act: "only with a react" fails;
 *  - dropping the `Object.hasOwn` check: "an emoji outside the 64" fails.
 */
import { describe, expect, test } from "vitest";
import { decideRequest, readDecideAnswers, type DecideBody } from "../functions/lib/gatewayRoutes/textDecide";
import { REACT_EMOJI } from "../functions/lib/reactEmoji";

const id = (n: number) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const BODY: DecideBody = { chat: "g", line: "+15555550001", style: "helpful", transcript: "x", candidates: [id(1)], running: false, waitingAsks: [], newest: id(1) };
const act = (choice: string) => ({ type: "choice", choice, confidence: 0.9, probabilities: {} });

/** The texting Worker's allowlist pins the same string (`apps/agent/src/reactEmoji.test.ts`). */
export const PINNED = "❤️👍👎😂🤣😊😁😉😍🤗🤔👀😮🤯😢😔☹️😬😅🤦🤷🙏👏🙌💪👌👋🫡🤝🤞🎉🥳🔥⭐✨💯🚀🏆💡‼️❓⏳📅⏰📝📚💻📱📧💰📈🏠✈️🚗☕🍕🥂🎂🎁🎵☀️🌙🐶🌱";

describe("the reaction emoji", () => {
  test("the 64, each a short option name the inference Worker accepts, each one emoji", () => {
    expect(Object.values(REACT_EMOJI).map((e) => e.emoji).join("")).toBe(PINNED);
    expect(Object.keys(REACT_EMOJI)).toHaveLength(64);
    for (const name of Object.keys(REACT_EMOJI)) expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,59}$/);
    const graphemes = new Intl.Segmenter();
    for (const { emoji } of Object.values(REACT_EMOJI)) expect([...graphemes.segment(emoji)]).toHaveLength(1);
  });

  // Jhonatan, 2026-11-01: reacting and writing are separate decisions; any act may carry the emoji.
  test("reacting is its own decision: it comes with silence (a react), an answer or a wait, and only when chosen", () => {
    const yes = { type: "noul", noul: 0.9 };
    const no = { type: "noul", noul: 0.1 };
    expect(readDecideAnswers(BODY, { act: act("silent"), also_react: yes, emoji: act("party") })).toMatchObject({ ok: true, act: "react", emoji: "🎉" });
    expect(readDecideAnswers(BODY, { act: act("answer"), also_react: yes, emoji: act("party") })).toMatchObject({ ok: true, act: "answer", emoji: "🎉" });
    expect(readDecideAnswers(BODY, { act: act("wait"), also_react: yes, emoji: act("party") })).toMatchObject({ ok: true, act: "wait", emoji: "🎉" });
    for (const other of ["answer", "silent", "wait"]) {
      const read = readDecideAnswers(BODY, { act: act(other), also_react: no, emoji: act("party") });
      expect(read).toMatchObject({ ok: true, act: other });
      expect(read).not.toHaveProperty("emoji");
    }
  });

  test("a wait carries the seconds decide chose, 1 to 8, and only a wait does", () => {
    expect(readDecideAnswers(BODY, { act: act("wait"), wait_seconds: { type: "score", score: 2, confidence: 0.8 } })).toMatchObject({ act: "wait", waitSeconds: 3 });
    expect(readDecideAnswers(BODY, { act: act("wait"), wait_seconds: { type: "score", score: 40, confidence: 0.8 } })).toMatchObject({ waitSeconds: 8 });
    expect(readDecideAnswers(BODY, { act: act("wait") })).toMatchObject({ waitSeconds: 1 });
    expect(readDecideAnswers(BODY, { act: act("answer"), wait_seconds: { type: "score", score: 2, confidence: 0.8 } })).not.toHaveProperty("waitSeconds");
  });

  test("an emoji outside the 64 is no emoji, never a guess", () => {
    for (const choice of ["unicorn", "toString", "__proto__"]) {
      expect(readDecideAnswers(BODY, { act: act("silent"), also_react: { type: "noul", noul: 0.9 }, emoji: act(choice) })).not.toHaveProperty("emoji");
    }
  });
});

describe("wait", () => {
  test("is an act that covers nothing", () => {
    expect(readDecideAnswers(BODY, { act: act("wait") })).toMatchObject({ ok: true, act: "wait", covers: [] });
    expect(Object.keys((decideRequest(BODY).questions as Record<string, { criteria: object }>).act.criteria)).toContain("wait");
  });
});

test("the request never passes 16 questions or 64 options, at its largest", () => {
  const waitingAsks = Array.from({ length: 8 }, (_, n) => id(10 + n));
  const { questions } = decideRequest({ ...BODY, candidates: [id(1), id(2)], newest: id(2), running: true, waitingAsks });
  const all = Object.values(questions as Record<string, { type: string; criteria: object }>);
  expect(all.length).toBeLessThanOrEqual(16);
  for (const question of all) if (question.type === "choice") expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(64);
});
