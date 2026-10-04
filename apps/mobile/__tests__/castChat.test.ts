import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { createSharedDoc, seedSharedDoc, type SharedDoc } from "../features/console/presence/sharedDoc";
import { createCastClock } from "../features/home/cast/castClock";
import { chatReducer, chatTool, plainName, type ChatState } from "../features/home/cast/castChat";
import { playCast, type CastMoment } from "../features/home/cast/castRun";
import { castTimeline } from "../features/home/cast/castTimeline";

/*
  A scene in a chat (Dev2, 2026-09-30): the assistant's steps show in its
  chat as it takes them, and the workspace changes beside it at that moment.
*/

const HOME = "# Home\n\nWelcome in.\n\n```cast\nCAST\n```\n";

function seeded(markdown: string): SharedDoc {
  const shared = createSharedDoc({});
  seedSharedDoc(shared, markdown);
  return shared;
}

function scene(script: string, options: { instant?: boolean; folderOpens?: boolean } = {}) {
  const { markdown, steps, problems } = splitWebsiteCast(HOME.replace("CAST", script));
  expect(problems).toEqual([]);
  const home = seeded(markdown);
  const clock = createCastClock();
  let chats: ChatState = [];
  // Everything that happened, in order: chat rows and workspace changes together.
  const log: string[] = [];
  const cues: CastMoment[] = [];
  const writes: string[] = [];
  let ended = false;
  const did = (what: string, path: string | null) => {
    log.push(what);
    return path;
  };
  const run = playCast(
    steps,
    home,
    {
      schedule: (ms, fn) => clock.schedule(ms, fn),
      instant: () => options.instant === true,
      pageNamed: () => null,
      addNote: (name, _text, folder) => did(`note ${folder ?? "."}/${name}`, `${folder ?? ""}/${name}.md`),
      workspace: {
        addFolder: (path) => did(`folder ${path}`, path),
        move: (path, into) => did(`move ${path} > ${into}`, `${into}/${path}`),
        rename: (path, name) => did(`rename ${path} > ${name}`, name),
        setStatus: (path, status) => did(`status ${path} = ${status}`, path),
        // A project nobody has: nothing is made, and nothing is claimed.
        addTask: (project, text) => (project === "nowhere" ? null : did(`task ${project}: ${text}`, `${project}/${text}.md`)),
      },
      chat: (event) => {
        chats = chatReducer(chats, event);
        if (event.kind === "tool") log.push(`${event.done ? "done" : "working"} ${event.verb} ${event.what}`);
      },
      agentDid: (_actor, kind, path) => {
        if (kind === "write") writes.push(path);
      },
      room: () => {},
      cue: (moment) => cues.push(moment),
      ended: () => {
        ended = true;
      },
      open: (name) => (options.folderOpens === true ? { path: name, shared: null } : null),
    },
    { path: "index.md" },
  );
  return { home, clock, run, log, cues, writes, chats: () => chats, ended: () => ended, playTo: (done: () => boolean) => clock.rush(done) };
}

describe("asking and answering", () => {
  test("a person types into the assistant's box, then sends it; the answer arrives word by word", () => {
    const show = scene("@maya asks Claude: keep track of it?\nClaude answers: On it, Maya.");
    const drafts: string[] = [];
    show.playTo(() => {
      const window = show.chats()[0];
      if (window !== undefined && window.draft !== "" && drafts[drafts.length - 1] !== window.draft) drafts.push(window.draft);
      return window?.messages.length === 1;
    });
    expect(drafts[0]).toBe("k");
    expect(drafts[drafts.length - 1]).toBe("keep track of it?");
    expect(show.chats()[0]).toEqual({ agent: "Claude", draft: "", messages: [{ kind: "asked", from: "@maya", text: "keep track of it?" }] });

    const growing: string[] = [];
    show.playTo(() => {
      const last = show.chats()[0]!.messages[1];
      if (last?.kind === "answer" && growing[growing.length - 1] !== last.text) growing.push(last.text);
      return last?.kind === "answer" && last.done;
    });
    expect(growing).toEqual(["On", "On it,", "On it, Maya."]);
  });

  test("ChatGPT and Claude each get a window, in the order they were asked", () => {
    const show = scene("@maya asks ChatGPT: plan the week\n@maya asks Claude: and file it\nClaude answers: Filed.\nChatGPT answers: Planned.");
    show.playTo(show.ended);
    expect(show.chats().map((window) => [window.agent, window.messages.map((message) => ("text" in message ? message.text : message.kind))])).toEqual([
      ["ChatGPT", ["plan the week", "Planned."]],
      ["Claude", ["and file it", "Filed."]],
    ]);
  });

  test("with reduced motion everything lands whole", () => {
    const show = scene("@maya asks Claude: keep track of it?\nClaude answers: On it.", { instant: true });
    show.playTo(show.ended);
    expect(show.chats()[0]!.messages).toEqual([
      { kind: "asked", from: "@maya", text: "keep track of it?" },
      { kind: "answer", id: 1, text: "On it.", done: true },
    ]);
  });
  test("an assistant giving up (a usage limit, an overload) is marked, so it can show in red", () => {
    const show = scene("@sam asks Claude: fix the refund bug\nClaude answers: Weekly usage limit reached.\nCodex answers: Fixed it.", { instant: true });
    show.playTo(show.ended);
    expect(show.chats().map((window) => window.messages.filter((message) => message.kind === "answer"))).toEqual([
      [{ kind: "answer", id: 1, text: "Weekly usage limit reached.", done: true, failed: true }],
      [{ kind: "answer", id: 2, text: "Fixed it.", done: true }],
    ]);
  });

  test("it is marked from its first word, not once it has finished arriving", () => {
    const show = scene("@sam asks Claude: fix it\nClaude answers: Weekly usage limit reached.");
    show.playTo(() => show.chats()[0]?.messages[1]?.kind === "answer");
    expect(show.chats()[0]!.messages[1]).toMatchObject({ text: "Weekly", done: false, failed: true });
  });
});

describe("what the assistant does, beside its chat", () => {
  const SCRIPT = [
    "@maya asks Claude: we picked Oct 14. keep track?",
    "Claude answers: On it.",
    "Claude adds folder: 1-projects/beta-launch",
    "Claude adds note: 1-projects/beta-launch/decisions",
    "  - Beta ships Oct 14",
    "Claude marks beta-launch as: in progress",
    "Claude adds task to beta-launch: Invite people",
    "Claude renames 1-projects/beta-launch/decisions to: launch decisions",
    "Claude moves 1-projects/old into: 4-archive",
    "Claude answers: Done.",
  ].join("\n");

  test("each step shows as working, then the change lands, then it shows as done", () => {
    const show = scene(SCRIPT);
    show.playTo(show.ended);
    expect(show.log).toEqual([
      "working Added folder Beta launch",
      "folder 1-projects/beta-launch",
      "done Added folder Beta launch",
      "working Added note Beta launch › Decisions",
      "note 1-projects/beta-launch/decisions",
      "done Added note Beta launch › Decisions",
      "working Marked Beta launch as in progress",
      "status beta-launch = in progress",
      "done Marked Beta launch as in progress",
      "working Added task Invite people",
      "task beta-launch: Invite people",
      "done Added task Invite people",
      "working Renamed Decisions to launch decisions",
      "rename 1-projects/beta-launch/decisions > launch decisions",
      "done Renamed Decisions to launch decisions",
      "working Moved Old into Archive",
      "move 1-projects/old > 4-archive",
      "done Moved Old into Archive",
    ]);
    // Steps taken in a row are one card; the answers are either side of it.
    expect(show.chats()[0]!.messages.map((message) => message.kind)).toEqual(["asked", "answer", "tools", "answer"]);
    expect(show.writes).toEqual([
      "1-projects/beta-launch",
      "1-projects/beta-launch/decisions.md",
      "beta-launch",
      "beta-launch/Invite people.md",
      "launch decisions",
      "4-archive/1-projects/old",
    ]);
  });

  test("the change lands a beat after the step appears, so the eye can follow it", () => {
    const show = scene(SCRIPT);
    let appeared: number | null = null;
    show.playTo(() => {
      if (appeared === null && show.log.includes("working Added folder Beta launch")) appeared = show.clock.now();
      return show.log.includes("folder 1-projects/beta-launch");
    });
    expect(appeared).not.toBeNull();
    expect(show.clock.now() - appeared!).toBeGreaterThanOrEqual(500);
  });

  test("with no chat open, the same steps simply happen", () => {
    const show = scene("Claude adds folder: 1-projects/beta-launch\nClaude marks beta-launch as: done");
    show.playTo(show.ended);
    expect(show.log).toEqual(["folder 1-projects/beta-launch", "status beta-launch = done"]);
    expect(show.chats()).toEqual([]);
  });

  test("a step on something that is not there changes nothing and claims nothing", () => {
    const show = scene("Claude adds task to nowhere: Invite people");
    show.playTo(show.ended);
    expect(show.writes).toEqual([]);
    expect(show.cues).not.toContain("note");
  });

  test("a person's steps are never shown in an assistant's chat", () => {
    const show = scene("@maya asks Claude: hi\n@maya adds folder: 1-projects/mine");
    show.playTo(show.ended);
    expect(show.log).toEqual(["folder 1-projects/mine"]);
  });

  test("opening a folder's page, the steps that write into a page wait for one", () => {
    const show = scene("@maya opens: 1-projects\nClaude writes: nowhere to go\nClaude marks beta as: done", { folderOpens: true });
    show.playTo(show.ended);
    expect(show.log).toEqual(["status beta = done"]);
    expect(show.home.text.toString()).not.toContain("nowhere to go");
  });

  test("the studio's clock times it", () => {
    const { markdown, steps } = splitWebsiteCast(HOME.replace("CAST", SCRIPT));
    const timeline = castTimeline(markdown, steps);
    expect(timeline.starts.every((start) => start !== null)).toBe(true);
    expect(timeline.moments.note).toBe(2);
  });
});

describe("how steps read in the chat", () => {
  test("names as people say them, never paths", () => {
    expect(plainName("1-projects")).toBe("Projects");
    expect(plainName("1-projects/beta-launch")).toBe("Beta launch");
    expect(plainName("launch_notes.md")).toBe("Launch notes");
    expect(chatTool({ kind: "join", actor: { name: "Claude", kind: "agent" } })).toBeNull();
  });
});
