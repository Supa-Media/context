import { describe, expect, test } from "@jest/globals";
import { renderContactNote } from "@context/communications";
import { groupContactActivity, shapeContactView } from "../features/console/communications/contact";

const adam = {
  name: "Adam Okonkwo",
  organization: "Example Industries",
  identifiers: [
    { kind: "email", value: "Adam@Example.net" },
    { kind: "phone", value: "+44 20 7946 0000" },
  ],
  activity: [
    {
      date: "2026-09-07",
      path: "0-inbox/email/name-at-example-com/2026-09-07.md",
      anchor: "msg-0123456789abcdef",
      label: "Quarterly numbers",
      channel: "email",
    },
    {
      date: "2026-08-14",
      path: "0-inbox/email/name-at-example-com/2026-08-14.md",
      anchor: "msg-fedcba9876543210",
      label: "Contract",
      channel: "email",
    },
    {
      date: "2026-08-02",
      path: "0-inbox/email/name-at-example-com/2026-08-02.md",
      anchor: "msg-1111111111111111",
      label: "Kickoff",
      channel: "email",
    },
  ],
  notes: "Prefers mornings. Met at the 2026 offsite.",
  now: "2026-09-07T18:04:11.221Z",
};

describe("shapeContactView", () => {
  test("reads the page back in full", () => {
    const view = shapeContactView(renderContactNote(adam));
    expect(view.name).toBe("Adam Okonkwo");
    expect(view.organization).toBe("Example Industries");
    expect(view.identifiers).toHaveLength(2);
    expect(view.activity).toHaveLength(3);
    expect(view.notes).toBe(adam.notes);
  });

  test("an activity link opens the channel-day at the anchor", () => {
    const [entry] = shapeContactView(renderContactNote(adam)).activity;
    expect(entry.path).toBe("0-inbox/email/name-at-example-com/2026-09-07");
    expect(entry.anchor).toBe("msg-0123456789abcdef");
  });

  test("a sender-written label carries no live link syntax through to the view", () => {
    const attacked = renderContactNote({
      ...adam,
      activity: [{ date: "2026-09-07", path: "0-inbox/email/x/2026-09-07.md", anchor: "msg-0123456789abcdef", label: "ok]] and [[.audit/anything", channel: "email" }],
    });
    const view = shapeContactView(attacked);
    expect(view.activity[0].label).not.toContain("]]");
    expect(view.activity[0].label).not.toContain("[[");
  });
});

describe("groupContactActivity", () => {
  test("grouped by month, newest first", () => {
    const groups = groupContactActivity(shapeContactView(renderContactNote(adam)));
    expect(groups.map((g) => g.month)).toEqual(["2026-09", "2026-08"]);
    expect(groups[1].entries).toHaveLength(2);
  });

  test("no activity is no groups", () => {
    expect(groupContactActivity(shapeContactView(renderContactNote({ name: "Nobody" })))).toEqual([]);
  });
});
