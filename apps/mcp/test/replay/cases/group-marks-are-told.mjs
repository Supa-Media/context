import assert from "node:assert/strict";
import { groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";
import { GROUP_RUN_LINE } from "../../../../../packages/tex/gateway/agent/groupRunLine.js";
import { pollOf } from "../../../../../packages/tex/worker/sendPoll.ts";
import { effectOf } from "../../../../../packages/tex/worker/sendEffect.ts";
import { groupRunOf } from "../../../../../packages/tex/worker/groupRun.ts";

export default {
  id: "group-marks-are-told",
  incident:
    "2026-11-24, Lab group chats on main: \"rename this chat\" got \"I don't have a tool that changes a group's name\", \"make us a poll\" became a poll note, and \"with confetti\" went without the effect.",
  cause:
    "The group prompt lists everything a group turn can do in prose and named none of these; they lived only in the long capability list, behind \"on your iMessage line\", which a turn can't check.",
  path: "group text",
  async run() {
    const told = groupPrompt({ key: "a".repeat(64), members: "b".repeat(64), from: "ana", chat: [], people: [] }, "crew");
    assert.ok(told.includes(GROUP_RUN_LINE), "every group turn is told it can");
    assert.match(GROUP_RUN_LINE, /never a tool/);
    assert.match(GROUP_RUN_LINE, /never say you can't/);
    // Every mark it teaches is one the Worker reads: a taught mark the line can't parse would be sent as words.
    assert.deepEqual(pollOf("(poll) Which night?\n- Thursday\n- Friday"), { title: "Which night?", choices: ["Thursday", "Friday"] });
    assert.equal(effectOf("(sent with Confetti) Launch day!").effect !== undefined, true);
    const run = groupRunOf("(name the chat) Launch Crew\n(add to the chat) +15555550199\nDone.", { text: "name it Launch Crew and add +15555550199" });
    assert.deepEqual(run.actions.map((a) => a.kind), ["name", "add"]);
    for (const mark of ["(poll)", "(sent with Confetti)", "(name the chat)", "(set the chat photo)", "(add to the chat)"]) assert.ok(GROUP_RUN_LINE.includes(mark), mark);
  },
};
