import { describe, expect, test } from "@jest/globals";
import {
  MAX_CAST_STEPS,
  castStepLine,
  castStepWords,
  renameCastActor,
  replaceCastStep,
  splitWebsiteCast,
  withCastWords,
  type CastStep,
} from "@context/shared";

/*
  Developer casts (Dev2, 2026-10-01): "it won't just be claude and chatgpt it
  will be claude code and codex and we need to be able to show them doing
  tasks running commands, and filling out project details in context and
  updating project statuses". An agent that runs a command or edits a file
  works in a terminal, and the terminal is where its Context work shows too.
*/

const block = (lines: string) => `# Home\n\n\`\`\`cast\n${lines}\n\`\`\`\n`;
const parse = (lines: string) => splitWebsiteCast(block(lines));
const codex = { name: "Codex", kind: "agent" } as const;
const claudeCode = { name: "Claude Code", kind: "agent" } as const;
const sam = { name: "@sam", kind: "person" } as const;

describe("terminal steps", () => {
  test("a command, with the output under it", () => {
    const { steps, problems } = parse(
      ['Codex runs: rg "chargeCard" src', "  payments/charge.ts:42  await chargeCard(order)", "  payments/retry.ts:18   return chargeCard(order)"].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      {
        kind: "run",
        actor: codex,
        command: 'rg "chargeCard" src',
        output: ["payments/charge.ts:42  await chargeCard(order)", "payments/retry.ts:18   return chargeCard(order)"],
      },
    ]);
  });

  test("a command with no output, and output that keeps its own indent", () => {
    const { steps } = parse(["Claude Code runs: pnpm install", "Codex runs: tree", "  src", "    payments", "", "Codex answers: done"].join("\n"));
    expect(steps[0]).toEqual({ kind: "run", actor: claudeCode, command: "pnpm install", output: [] });
    // Two spaces mark the body; anything past them is the output's own, and a trailing blank goes.
    expect(steps[1]).toEqual({ kind: "run", actor: codex, command: "tree", output: ["src", "  payments"] });
    expect(steps[2]).toEqual({ kind: "answer", actor: codex, text: "done" });
  });

  test("an edit, with its diff", () => {
    const { steps, problems } = parse(["Codex edits: payments/retry.ts", "  - return chargeCard(order)", "  + return chargeCard(order, { key: order.id })"].join("\n"));
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { kind: "edit", actor: codex, file: "payments/retry.ts", diff: ["- return chargeCard(order)", "+ return chargeCard(order, { key: order.id })"] },
    ]);
  });

  test("asking to run a command, and a person allowing or denying it", () => {
    const { steps, problems } = parse(
      ["Claude Code asks to run: pnpm test payments", "@sam allows", "Claude Code asks to run: rm -rf dist", "@sam denies it"].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { kind: "approve", actor: claudeCode, command: "pnpm test payments" },
      { kind: "allow", actor: sam, allowed: true },
      { kind: "approve", actor: claudeCode, command: "rm -rf dist" },
      { kind: "allow", actor: sam, allowed: false },
    ]);
  });

  test("asking to run is never read as asking an assistant called 'to run'", () => {
    expect(parse("Codex asks to run: ls").steps[0]?.kind).toBe("approve");
    expect(parse("@sam asks Codex: run the tests").steps[0]?.kind).toBe("ask");
  });

  test("nothing to allow yet is said, not guessed", () => {
    const { steps, problems } = parse("@sam allows");
    expect(steps).toEqual([]);
    expect(problems).toEqual(["Nothing has asked to run a command yet: @sam allows"]);
  });

  test("only an assistant runs, edits or asks to run", () => {
    const { steps, problems } = parse(["@sam runs: ls", "@sam edits: a.ts", "@sam asks to run: ls"].join("\n"));
    expect(steps).toEqual([]);
    expect(problems).toEqual([
      "Only an assistant runs commands or edits files here, like Codex: @sam runs: ls",
      "Only an assistant runs commands or edits files here, like Codex: @sam edits: a.ts",
      "Only an assistant runs commands or edits files here, like Codex: @sam asks to run: ls",
    ]);
  });

  test("a long output is cut, so a page cannot script an endless one", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `  line ${index}`);
    const step = parse(["Codex runs: yes", ...lines].join("\n")).steps[0];
    expect(step?.kind === "run" ? step.output.length : 0).toBe(16);
  });
});

describe("terminals", () => {
  test("`terminal:` names an assistant and the folder it works in", () => {
    const { chat, problems } = parse(["terminal: Codex in ~/shop-api", "terminal: Claude Code in ~/shop-api", "Codex runs: ls"].join("\n"));
    expect(problems).toEqual([]);
    expect(chat).toEqual({
      layout: "side",
      look: "warm",
      terminals: [
        { agent: "Codex", folder: "~/shop-api" },
        { agent: "Claude Code", folder: "~/shop-api" },
      ],
    });
  });

  test("an assistant that runs or edits has a terminal even when none was named", () => {
    const { chat } = parse(["phone: one app", "Claude Code edits: a.ts", "Codex asks to run: ls"].join("\n"));
    expect(chat).toEqual({
      layout: "side",
      look: "warm",
      phone: "one",
      terminals: [
        { agent: "Claude Code", folder: "~" },
        { agent: "Codex", folder: "~" },
      ],
    });
  });

  test("a chat or phone line after the terminals keeps them, and naming one twice keeps the last", () => {
    const { chat } = parse(["terminal: Codex in ~/a", "terminal: Codex in ~/b", "chat: dark", "phone: split"].join("\n"));
    expect(chat).toEqual({ layout: "side", look: "dark", phone: "split", terminals: [{ agent: "Codex", folder: "~/b" }] });
  });

  test("a terminal with no folder, and one that is not an assistant", () => {
    expect(parse("terminal: Codex").chat?.terminals).toEqual([{ agent: "Codex", folder: "~" }]);
    const wrong = parse("terminal: @sam in ~/x");
    expect(wrong.chat).toBeUndefined();
    expect(wrong.problems).toEqual(["Not an assistant to give a terminal: @sam. Try terminal: Codex in ~/shop-api."]);
  });

  test("a page cannot name an endless row of terminals", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `terminal: Agent${index} in ~/x`);
    expect(parse(lines.join("\n")).chat?.terminals).toHaveLength(6);
  });

  test("a scene with no terminal steps says nothing about terminals", () => {
    expect(parse("chat: dark\n@maya asks Claude: hi").chat).toEqual({ layout: "side", look: "dark" });
  });
});

describe("writing terminal steps back", () => {
  const steps: CastStep[] = [
    { kind: "run", actor: codex, command: "pnpm test", output: ["✓ 38 passed", "  ✗ refunds"] },
    { kind: "edit", actor: claudeCode, file: "a.ts", diff: ["- old", "+ new"] },
    { kind: "approve", actor: claudeCode, command: "pnpm test payments" },
    { kind: "allow", actor: sam, allowed: true },
    { kind: "allow", actor: sam, allowed: false },
  ];

  test("each reads back as the same step", () => {
    for (const step of steps) {
      const written = steps.filter((one) => one.kind === "approve").map(castStepLine).join("\n");
      const source = step.kind === "allow" ? `${written}\n${castStepLine(step)}` : castStepLine(step);
      const parsed = parse(source).steps;
      expect(parsed[parsed.length - 1]).toEqual(step);
    }
  });

  test("the words a row edits: the command or the file", () => {
    expect(castStepWords(steps[0]!)).toBe("pnpm test");
    expect(castStepWords(steps[1]!)).toBe("a.ts");
    expect(castStepWords(steps[2]!)).toBe("pnpm test payments");
    expect(castStepWords(steps[3]!)).toBeNull();
    expect(withCastWords(steps[0]!, "pnpm lint")).toEqual({ ...steps[0], command: "pnpm lint" });
    expect(withCastWords(steps[1]!, "b.ts")).toEqual({ ...steps[1], file: "b.ts" });
    expect(withCastWords(steps[2]!, "")).toBeNull();
  });

  test("changing a run keeps the page's other lines, and its output", () => {
    const source = block(["Codex runs: pnpm test", "  ✓ 38 passed", "Codex answers: done"].join("\n"));
    const run = splitWebsiteCast(source).steps[0]!;
    const changed = replaceCastStep(source, 0, withCastWords(run, "pnpm test payments"));
    expect(changed).toBe(block(["Codex runs: pnpm test payments", "  ✓ 38 passed", "Codex answers: done"].join("\n")));
  });

  test("renaming an assistant renames its terminal too", () => {
    const source = block(["terminal: Codex in ~/shop-api", "Codex runs: ls"].join("\n"));
    const renamed = renameCastActor(source, "Codex", { name: "Cursor", kind: "agent" });
    expect(renamed).toBe(block(["terminal: Cursor in ~/shop-api", "Cursor runs: ls"].join("\n")));
  });
});

describe("the first developer script", () => {
  // @supa scenes/14-codex-to-claude-code-mobile, as Dev2 approved it (2026-10-01).
  const SCRIPT = "pace: fast\nphone: split\nterminal: Codex in ~/shop-api\nterminal: Claude Code in ~/shop-api\n@sam opens: projects/checkout-v2/overview\n@sam asks Codex: fix the double charge when a payment retries\nCodex reads: Checkout v2\nCodex runs: rg \"chargeCard\" src\n  payments/charge.ts:42  await chargeCard(order)\n  payments/retry.ts:18   return chargeCard(order)\nCodex edits: payments/retry.ts\n  - return chargeCard(order)\n  + return chargeCard(order, { key: order.id })\nCodex runs: pnpm test payments\n  ✓ 38 passed\n  ✗ refunds › partial refund after retry\nCodex ticks: Idempotency key on retries\nCodex writes: Retries now send the order id as their key, so a card is charged once.\nCodex adds task to checkout-v2: Fix partial refund after retry\nCodex marks checkout-v2 as: in progress\nCodex answers: Fixed the retry charge. One refund test still fails; I added it as a task.\n@sam asks Codex: fix the refund one too\nCodex answers: Usage limit reached. Try again in 4 hours.\nwait 2s\n@sam asks Claude Code: finish checkout-v2\nClaude Code reads: Checkout v2\nClaude Code reads: Fix partial refund after retry\nClaude Code runs: pnpm test refunds\n  ✗ partial refund after retry: expected 1 charge, got 2\nClaude Code edits: payments/refund.ts\n  - const key = randomUUID()\n  + const key = `${order.id}:refund`\nshows: Claude Code\nClaude Code asks to run: pnpm test payments\n@sam allows\nClaude Code runs: pnpm test payments\n  ✓ 39 passed\nshows: both\nClaude Code marks Fix partial refund after retry as: done\nClaude Code writes: Partial refunds fixed too. All 39 payment tests pass. PR #214 is up.\nClaude Code marks checkout-v2 as: done\nClaude Code answers: Done. Codex's notes said where it stopped, so I picked up the refund test. PR #214 is up.\n@jo comments on \"PR #214\": reviewing now\nwait 4s";

  test("is understood whole, inside the step limit", () => {
    const { steps, problems, chat } = parse(SCRIPT);
    expect(problems).toEqual([]);
    expect(steps.length).toBeLessThanOrEqual(MAX_CAST_STEPS);
    expect(steps.filter((step) => step.kind === "run")).toHaveLength(4);
    expect(chat?.terminals?.map((terminal) => terminal.agent)).toEqual(["Codex", "Claude Code"]);
  });
});
