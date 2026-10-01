import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import { createCastClock } from "../features/home/cast/castClock";
import { chatReducer, type ChatMessage, type ChatState } from "../features/home/cast/castChat";
import { phoneShowsAfter } from "../features/home/cast/castCamera";
import { castColors, playCast, type CastMoment } from "../features/home/cast/castRun";
import { presenceColors } from "../features/design/tokens";

/*
  Developer casts (Dev2, 2026-10-01): Codex and Claude Code in terminals,
  running commands, editing files, asking before they run one, and doing
  their Context work (statuses, tasks, notes) from the same terminal.
*/

const HOME = "# Checkout v2\n\nStop double charges.\n\n- [ ] Idempotency key on retries\n\n```cast\nCAST\n```\n";

function scene(script: string, options: { instant?: boolean } = {}) {
  const cast = splitWebsiteCast(HOME.replace("CAST", script));
  expect(cast.problems).toEqual([]);
  const shared = createSharedDoc({});
  seedSharedDoc(shared, cast.markdown);
  const clock = createCastClock();
  let chats: ChatState = [];
  const cues: CastMoment[] = [];
  const log: string[] = [];
  let ended = false;
  playCast(
    cast.steps,
    shared,
    {
      schedule: (ms, fn) => clock.schedule(ms, fn),
      instant: () => options.instant === true,
      pageNamed: (name) => (name === "Checkout v2" ? "index.md" : null),
      addNote: () => null,
      workspace: {
        addFolder: () => null,
        move: () => null,
        rename: () => null,
        setStatus: (path, status) => {
          log.push(`status ${path} = ${status}`);
          return path;
        },
        addTask: (project, text) => {
          log.push(`task ${project}: ${text}`);
          return `${project}/${text}.md`;
        },
      },
      chat: (event) => {
        chats = chatReducer(chats, event);
      },
      agentDid: () => {},
      room: () => {},
      cue: (moment) => cues.push(moment),
      ended: () => {
        ended = true;
      },
    },
    { path: "index.md", terminals: cast.chat?.terminals?.map((terminal) => terminal.agent) },
  );
  const messages = (agent: string): ChatMessage[] => chats.find((window) => window.agent === agent)?.messages ?? [];
  return { clock, log, cues, messages, chats: () => chats, ended: () => ended, playTo: (done: () => boolean) => clock.rush(done) };
}

describe("a command in a terminal", () => {
  test("the command shows at once, then what it printed arrives a line at a time", () => {
    const show = scene(["Codex runs: pnpm test payments", "  ✓ 38 passed", "  ✗ refunds › partial refund after retry"].join("\n"));
    const seen: string[][] = [];
    show.playTo(() => {
      const run = show.messages("Codex")[0];
      if (run?.kind === "run" && seen[seen.length - 1]?.length !== run.output.length) seen.push([...run.output]);
      return run?.kind === "run" && run.done;
    });
    expect(seen).toEqual([[], ["✓ 38 passed"], ["✓ 38 passed", "✗ refunds › partial refund after retry"]]);
    expect(show.messages("Codex")).toEqual([
      { kind: "run", id: 1, command: "pnpm test payments", output: ["✓ 38 passed", "✗ refunds › partial refund after retry"], done: true },
    ]);
  });

  test("it is not done until the last line has printed", () => {
    const show = scene(["Codex runs: pnpm test", "  one", "  two"].join("\n"));
    show.playTo(() => show.messages("Codex")[0]?.kind === "run");
    const first = show.messages("Codex")[0];
    expect(first?.kind === "run" && first.done).toBe(false);
  });

  test("an edit lands whole, as its diff", () => {
    const show = scene(["Codex edits: payments/retry.ts", "  - return chargeCard(order)", "  + return chargeCard(order, { key: order.id })"].join("\n"));
    show.playTo(show.ended);
    expect(show.messages("Codex")).toEqual([
      { kind: "edit", id: 1, file: "payments/retry.ts", diff: ["- return chargeCard(order)", "+ return chargeCard(order, { key: order.id })"] },
    ]);
  });

  test("with reduced motion a command's output lands whole", () => {
    const show = scene(["Codex runs: pnpm test", "  one", "  two"].join("\n"), { instant: true });
    show.playTo(() => show.messages("Codex").length > 0);
    expect(show.messages("Codex")[0]).toEqual({ kind: "run", id: 1, command: "pnpm test", output: ["one", "two"], done: true });
  });
});

describe("asking to run a command", () => {
  test("it waits, then shows who allowed it", () => {
    const show = scene(["Claude Code asks to run: pnpm test payments", "@sam allows", "Claude Code runs: pnpm test payments", "  ✓ 39 passed"].join("\n"));
    show.playTo(() => show.messages("Claude Code").length === 1);
    expect(show.messages("Claude Code")).toEqual([{ kind: "approval", id: 1, command: "pnpm test payments", answer: "waiting" }]);
    show.playTo(show.ended);
    expect(show.messages("Claude Code").map((message) => message.kind)).toEqual(["approval", "run"]);
    expect(show.messages("Claude Code")[0]).toEqual({ kind: "approval", id: 1, command: "pnpm test payments", answer: "allowed", by: "@sam" });
  });

  test("a denial is said too, and a second answer to the same question changes nothing", () => {
    const show = scene(["Codex asks to run: rm -rf dist", "@sam denies", "@sam allows"].join("\n"));
    show.playTo(show.ended);
    expect(show.messages("Codex")).toEqual([{ kind: "approval", id: 1, command: "rm -rf dist", answer: "denied", by: "@sam" }]);
  });
});

describe("Context work from a terminal", () => {
  test("a named terminal's Context work shows in it from its first step, beside the workspace changing", () => {
    const show = scene(
      [
        "terminal: Codex in ~/shop-api",
        "Codex reads: Checkout v2",
        "Codex ticks: Idempotency key on retries",
        "Codex adds task to checkout-v2: Fix partial refund after retry",
        "Codex marks checkout-v2 as: in progress",
      ].join("\n"),
    );
    show.playTo(show.ended);
    const tools = show.messages("Codex").flatMap((message) => (message.kind === "tools" ? message.tools.map((tool) => `${tool.verb} ${tool.what}`) : []));
    expect(tools).toEqual(["Read Checkout v2", "Ticked Idempotency key on retries", "Added task Fix partial refund after retry", "Marked Checkout v2 as in progress"]);
    expect(show.log).toEqual(["task checkout-v2: Fix partial refund after retry", "status checkout-v2 = in progress"]);
  });

  test("an assistant's first command opens its terminal, though nobody asked it anything", () => {
    const show = scene(["Codex runs: ls", "Codex marks checkout-v2 as: done"].join("\n"));
    show.playTo(show.ended);
    expect(show.messages("Codex").map((message) => message.kind)).toEqual(["run", "tools"]);
  });
});

describe("sounds and the phone", () => {
  test("a command, each line it prints, an edit and an answer to an approval each have a moment", () => {
    const show = scene(
      ["Codex runs: pnpm test", "  ✓ 1 passed", "Codex edits: a.ts", "  + x", "Codex asks to run: git push", "@sam allows"].join("\n"),
    );
    show.playTo(show.ended);
    expect(show.cues.filter((cue) => cue !== "agent")).toEqual(["click", "typing", "writes", "writes", "comment", "click"]);
  });

  test("a phone showing one app at a time goes to the terminal for a command, an edit or a question", () => {
    expect(phoneShowsAfter("context", { kind: "run", agent: "Codex", id: 1, command: "ls", output: [], done: false }, "one")).toBe("Codex");
    expect(phoneShowsAfter("context", { kind: "edit", agent: "Codex", id: 1, file: "a.ts", diff: [] }, "one")).toBe("Codex");
    expect(phoneShowsAfter("context", { kind: "approval", agent: "Codex", id: 1, command: "ls", answer: "waiting" }, "one")).toBe("Codex");
    // Printing more of a command it is already showing stays where the film is.
    expect(phoneShowsAfter("context", { kind: "run", agent: "Codex", id: 1, command: "ls", output: ["a"], done: true }, "one")).toBe("context");
    expect(phoneShowsAfter(undefined, { kind: "run", agent: "Codex", id: 1, command: "ls", output: [], done: false }, "split")).toBe("both");
  });
});

test("Claude Code and Codex keep the hues people know them by, as their terminals do", () => {
  const { steps } = splitWebsiteCast("```cast\nCodex runs: ls\nClaude Code runs: ls\n@sam allows\n```".replace("@sam allows", "Claude Code asks to run: ls\n@sam allows"));
  const colors = castColors(steps);
  expect(colors.get("Codex")).toBe(presenceColors.green);
  expect(colors.get("Claude Code")).toBe(presenceColors.amber);
});
