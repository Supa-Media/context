import assert from "node:assert/strict";
import test from "node:test";
import { lineProblemsIn } from "./tex-line-alert.mjs";

test("a healthy window reports nothing", () => {
  assert.deepEqual(lineProblemsIn([{ event: "bridge.health" }, { event: "deliver.retry" }]), []);
});

test("a held chat and a parked event are each one line of counts", () => {
  const problems = lineProblemsIn([
    { event: "bridge.alert", outcome: "chat_held" },
    { event: "bridge.alert", outcome: "chat_held" },
    { event: "bridge.alert", outcome: "event_parked" },
  ]);
  assert.deepEqual(problems, ["2 chats held behind a failing event for 2 minutes or more", "1 events set aside after 5 minutes of failing (their chats moved on)"]);
});
