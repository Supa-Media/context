/**
 * The foot of a note on a phone: the retry that replaced the `✓` key.
 *
 * The phone's bottom row lost its Save key when it became the five-key capsule
 * (owner, 2026-09-27). Autosave and the sync mark cover every state but the
 * ones autosave will not retry from — a failed save, a conflict — and
 * `editor.ts` insists the manual route stays reachable there. So `noteFoot`
 * offers the Save button at the foot of the note at every density now.
 *
 * SABOTAGE: `manualSave` gated on `!compact` again. "a failed save offers Save
 * at the foot of a phone's note" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { noteFoot } from "../features/console/files/noteEditor/statusLine";
import type { EditorState } from "../features/console/files/editor";

function state(over: Partial<EditorState>): EditorState {
  return {
    path: "1-projects/plan.md",
    draft: "# Plan\n",
    status: "clean",
    ...over,
  } as EditorState;
}

describe("a phone's note foot", () => {
  test("a failed save offers Save at the foot of a phone's note", () => {
    const foot = noteFoot({
      state: state({ status: "error", message: "We don't know whether that save landed." }),
      presence: undefined,
      editable: true,
      compact: true,
      button: { label: "Try again", disabled: false },
    });
    expect(foot.manualSave).toBe(true);
    expect(foot.explains).toBe(true);
  });

  test("a note that is simply saved offers nothing to press", () => {
    const foot = noteFoot({
      state: state({ status: "clean" }),
      presence: undefined,
      editable: true,
      compact: true,
      button: { label: "Save", disabled: true },
    });
    expect(foot.manualSave).toBe(false);
  });

  test("and a draft autosave is about to write offers nothing either", () => {
    const foot = noteFoot({
      state: state({ status: "dirty" }),
      presence: undefined,
      editable: true,
      compact: true,
      button: { label: "Save", disabled: false },
    });
    expect(foot.manualSave).toBe(false);
  });
});
