import { describe, expect, test } from "@jest/globals";
import { castStepLine, splitWebsiteCast, withCastWords, renameCastActor, type CastStep } from "@context/shared";

/*
  Scenes set in a chat (Dev2, 2026-09-30): "I want people to be able to see
  how their folder structure changes in real time as they chat with claude or
  chat gpt or both … seeing folders move, notes get renamed, project items
  status getting updated in list view".
*/

const block = (lines: string) => `# Home\n\n\`\`\`cast\n${lines}\n\`\`\`\n`;
const parse = (lines: string) => splitWebsiteCast(block(lines));

describe("chat steps", () => {
  test("asking an assistant, and its answer", () => {
    const { steps, problems } = parse("@maya asks Claude: we picked Oct 14. keep track of it?\nClaude answers: On it.");
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { kind: "ask", actor: { name: "@maya", kind: "person" }, agent: "Claude", text: "we picked Oct 14. keep track of it?" },
      { kind: "answer", actor: { name: "Claude", kind: "agent" }, text: "On it." },
    ]);
  });

  test("two assistants in one scene, and somebody's own", () => {
    const { steps, problems } = parse("@maya asks ChatGPT: plan the week\n@jon asks @jon's Claude: and mine?");
    expect(problems).toEqual([]);
    expect(steps.map((step) => (step.kind === "ask" ? step.agent : null))).toEqual(["ChatGPT", "@jon's Claude"]);
  });

  test("a person is not an assistant to ask", () => {
    const { steps, problems } = parse("@maya asks @jon: lunch?");
    expect(steps).toEqual([]);
    expect(problems).toEqual(["Only an assistant can be asked, like Claude: @maya asks @jon: lunch?"]);
  });

  test("how the chat is framed, in any order, and the default", () => {
    expect(parse("chat: dark, cut").chat).toEqual({ layout: "cut", look: "dark" });
    expect(parse("chat: chat, then cut").chat).toEqual({ layout: "cut", look: "warm" });
    expect(parse("chat: side by side, plain").chat).toEqual({ layout: "side", look: "plain" });
    expect(parse("Claude answers: hi").chat).toBeUndefined();
    const wrong = parse("chat: sideways");
    expect(wrong.chat).toBeUndefined();
    expect(wrong.problems[0]).toMatch(/^Not a way to show a chat: sideways/);
  });
});

describe("workspace steps", () => {
  test("folders, notes in folders, moves, renames, statuses and tasks", () => {
    const { steps, problems } = parse(
      [
        "Claude adds folder: 1-projects/beta-launch",
        "Claude adds note: 1-projects/beta-launch/decisions",
        "  - Beta ships Oct 14",
        "Claude marks beta-launch as: In Progress",
        "Claude sets 1-projects/website to: done",
        "Claude adds task to beta-launch: Invite the first 50 people",
        "Claude renames 1-projects/beta-launch/decisions to: launch decisions",
        "Claude moves 1-projects/old notes into: 4-archive",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    const claude = { name: "Claude", kind: "agent" };
    expect(steps).toEqual([
      { kind: "folder", actor: claude, path: "1-projects/beta-launch" },
      { kind: "note", actor: claude, name: "decisions", text: "- Beta ships Oct 14", folder: "1-projects/beta-launch" },
      { kind: "status", actor: claude, path: "beta-launch", status: "in progress" },
      { kind: "status", actor: claude, path: "1-projects/website", status: "done" },
      { kind: "task", actor: claude, project: "beta-launch", text: "Invite the first 50 people" },
      { kind: "rename", actor: claude, path: "1-projects/beta-launch/decisions", name: "launch decisions" },
      { kind: "move", actor: claude, path: "1-projects/old notes", into: "4-archive" },
    ]);
  });

  test("a note with no path is still beside the page", () => {
    const [step] = parse("Claude adds note: getting-started").steps;
    expect(step).toEqual({ kind: "note", actor: { name: "Claude", kind: "agent" }, name: "getting-started", text: "" });
  });

  test("a path never climbs out, nor into Context's own folder", () => {
    const { steps } = parse("Claude adds folder: ../../secrets\nClaude moves .context/privacy into: ../x\nClaude adds note: .context/../inbox/a");
    expect(steps).toEqual([
      { kind: "folder", actor: { name: "Claude", kind: "agent" }, path: "secrets" },
      { kind: "move", actor: { name: "Claude", kind: "agent" }, path: "privacy", into: "x" },
      { kind: "note", actor: { name: "Claude", kind: "agent" }, name: "a", text: "", folder: "inbox" },
    ]);
  });
});

describe("written back by the studio", () => {
  const every = [
    "chat: side by side",
    "@maya asks Claude: keep track of it?",
    "Claude answers: On it.",
    "Claude adds folder: 1-projects/beta-launch",
    "Claude adds note: 1-projects/beta-launch/decisions",
    "Claude marks beta-launch as: in progress",
    "Claude adds task to beta-launch: Invite people",
    "Claude renames 1-projects/beta-launch/decisions to: launch decisions",
    "Claude moves 1-projects/old into: 4-archive",
  ].join("\n");

  test("each step reads back as itself", () => {
    const { steps } = parse(every);
    const again = parse(steps.map(castStepLine).join("\n")).steps;
    expect(again).toEqual(steps);
  });

  test("the words a row types over", () => {
    const steps = parse(every).steps;
    const changed = steps.map((step) => withCastWords(step, "Next week"));
    expect(changed.map((step) => (step === null ? null : castStepLine(step)))).toEqual([
      "@maya asks Claude: Next week",
      "Claude answers: Next week",
      "Claude adds folder: Next week",
      "Claude adds note: 1-projects/beta-launch/Next week",
      "Claude marks beta-launch as: next week",
      "Claude adds task to beta-launch: Next week",
      "Claude renames 1-projects/beta-launch/decisions to: Next week",
      "Claude moves 1-projects/old into: Next week",
    ]);
  });

  test("renaming an assistant renames who was asked, too", () => {
    const out = renameCastActor(block("@maya asks Claude: hi\nClaude answers: hello"), "Claude", { name: "ChatGPT", kind: "agent" });
    const steps: CastStep[] = splitWebsiteCast(out).steps;
    expect(steps.map(castStepLine)).toEqual(["@maya asks ChatGPT: hi", "ChatGPT answers: hello"]);
  });
});
