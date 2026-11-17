/**
 * A bench group chat's grant (`groupChat.mjs`) holds the lowest role anyone in the chat holds in that
 * workspace, as production does (`textGroupReach.ts`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupRole } from "../groupChat.mjs";

test("the group grant is the lowest role in the chat, not the tagger's", () => {
  const band = [
    { person: "Maya", workspace: "maya", role: "owner", personal: true },
    { person: "Maya", workspace: "band", role: "member" },
    { person: "Priya", workspace: "band", role: "owner" },
  ];
  assert.equal(groupRole(band, "band"), "member", "Maya can only read, so the chat can only read");
  assert.equal(groupRole(band, "band"), groupRole([...band].reverse(), "band"), "who tagged does not change it");
  assert.equal(
    groupRole(
      [
        { workspace: "flat", role: "owner" },
        { workspace: "flat", role: "editor" },
      ],
      "flat",
    ),
    "editor",
  );
  assert.equal(
    groupRole(
      [
        { workspace: "brand", role: "owner" },
        { workspace: "brand", role: "owner" },
      ],
      "brand",
    ),
    "owner",
  );
  assert.equal(groupRole([], "band"), "member");
});
