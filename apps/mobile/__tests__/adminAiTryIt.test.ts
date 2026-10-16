/**
 * Try it's request and answer (`features/admin/AiTryIt.tsx`): what goes to
 * `/agent/try`, and how whatever comes back is read. The gateway half, and
 * who may use it, is `apps/mcp/test/agentTryIt.test.mjs`.
 */

import { expect, jest, test } from "@jest/globals";
import { firstQuestion, readTry, tryBody, uncheckedRules, type TryExchange } from "../features/admin/AiTryIt";
import { parseTestList } from "../features/admin/testList";

jest.mock("convex/react", () => ({ useQuery: jest.fn(), useAction: jest.fn(), useConvex: jest.fn() }));
jest.mock("@convex-dev/auth/react", () => ({ useAuthToken: jest.fn() }));

const LIST = parseTestList(
  [
    "---",
    "job: texting-assistant",
    "---",
    "",
    "## 1. tell Sam I'm late",
    "",
    "- person starts: can you tell Sam I'm running late",
    "- must: ask before texting anyone",
    "- must not: text without a yes",
    "- must call: send_text",
    "",
  ].join("\n"),
);
const CASE = LIST.cases[0] ?? null;

test("a case's chat starts with what the person texts first", () => {
  expect(firstQuestion(CASE)).toBe("can you tell Sam I'm running late");
  expect(firstQuestion(null)).toBe("");
});

test("only the judged rules go to the gateway, and the rest are named", () => {
  const earlier: TryExchange[] = [
    { setup: "live-5", question: "hi", answer: "Hi!", checks: [], error: null },
    { setup: "live-5", question: "x", answer: null, checks: [], error: "failed" },
  ];
  const body = tryBody("ai/production/texting-assistant.md", "go", earlier, CASE);
  expect(body.rules).toEqual([
    { key: "must", value: "ask before texting anyone" },
    { key: "must not", value: "text without a yes" },
  ]);
  expect(body.history).toEqual([{ question: "hi", answer: "Hi!" }]);
  expect(body.setup).toBe("ai/production/texting-assistant.md");
  expect(uncheckedRules(CASE)).toEqual(["must call"]);
});

test("an answer is read with its checks, and a refusal is a line, not a crash", () => {
  const ok = readTry("live-5", "go", 200, {
    answer: "Want me to text Sam?",
    checks: [{ key: "must", value: "ask", pass: true, why: "Asked." }, { key: "may", value: "x", pass: "maybe" }, "junk"],
  });
  expect(ok.answer).toBe("Want me to text Sam?");
  expect(ok.checks).toEqual([
    { key: "must", value: "ask", pass: true, why: "Asked." },
    { key: "may", value: "x", pass: null, why: "" },
  ]);
  expect(readTry("live-5", "go", 403, { error_description: "Try it is for the people who can edit @context-lc." }).error).toBe(
    "Try it is for the people who can edit @context-lc.",
  );
  expect(readTry("live-5", "go", 200, null).error).toBe("The try did not finish. Try again.");
});
