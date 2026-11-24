/**
 * Tex's sends on its iMessage line, as the Lab's Chat view draws them (Dev, 2026-11-24, approved artboards
 * `group-chat-features-artboards/`): the marks Tex writes ("(sent with Slam)", "(poll)", "@handle") read back as the
 * effect, the poll card and the tag, never shown as words; running the group as event lines; and a person's typed
 * "@Tex" left as plain words, as iMessage sends it (Dev, 2026-11-24: "do it like imessage").
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-24):
 *  1. texSendOf keeping the "(sent with …)" mark in the words -> "an effect's mark" fails;
 *  2. chatEntries drawing Tex's "named the conversation" row as a bubble -> "running the group is an event line" fails.
 */
import { describe, expect, test } from "@jest/globals";
import type { SandboxRow } from "@context/lab/app/engine/sandbox";
import { chatEntries } from "@context/lab/app/views/canvas/world/chatModel";
import { texEventOf, texSendOf, texTags } from "@context/lab/app/views/canvas/world/texSends";

const at = Date.UTC(2026, 10, 24, 14, 0);
const row = (r: Partial<SandboxRow> & { id: string }): SandboxRow => ({ who: "", text: "", at, ...r });

describe("texSendOf", () => {
  test("an effect's mark comes off the words and names the effect", () => {
    expect(texSendOf("(sent with Slam) we got the table")).toEqual({ text: "we got the table", effect: "Slam" });
    expect(texSendOf("(sent with invisible ink) it's a surprise party")).toEqual({ text: "it's a surprise party", effect: "Invisible Ink" });
  });

  test("a mark with no words, or an unknown effect, stays as written", () => {
    expect(texSendOf("(sent with Slam)")).toEqual({ text: "(sent with Slam)" });
    expect(texSendOf("(sent with Sparkle) hi")).toEqual({ text: "(sent with Sparkle) hi" });
  });

  test("a poll is its question and choices", () => {
    expect(texSendOf("(poll) Where Friday?\n- Thai\n- Pizza\n- Thai")).toEqual({ text: "Where Friday?", poll: { title: "Where Friday?", choices: ["Thai", "Pizza"] } });
    expect(texSendOf("(poll) Where?\n- Thai\nmore words")).toEqual({ text: "Where?\n- Thai\nmore words" });
  });
});

describe("texTags", () => {
  test("Tex's @handle of someone here is their first name as a tag; anyone else's @word stays", () => {
    expect(texTags("@sam-lee can you book it? cc @nobody", { "Sam Lee": "sam-lee" })).toEqual([{ t: "Sam", tag: true }, { t: " can you book it? cc @nobody" }]);
    expect(texTags("no tags", {})).toEqual([{ t: "no tags" }]);
  });
});

describe("texEventOf", () => {
  test("the simulated group's lines for running the group", () => {
    expect(texEventOf("Tex named the conversation “Lisbon trip”.")).toEqual({ text: "Tex named the conversation “Lisbon trip”.", photo: false });
    expect(texEventOf("Tex changed the group photo.")).toEqual({ text: "Tex changed the group photo.", photo: true });
    expect(texEventOf("Tex added +15550100123 to the conversation.")?.photo).toBe(false);
    expect(texEventOf("I named it Lisbon trip")).toBeNull();
  });
});

describe("the Chat view draws Tex's sends", () => {
  const rows = [
    row({ id: "1", who: "Alpha Diaz", text: "@Tex call this chat Lisbon trip and make this the photo", pics: ["https://example.com/p.jpg"] }),
    row({ id: "2", who: "Tex", tex: true, text: "Tex named the conversation “Lisbon trip”." }),
    row({ id: "3", who: "Tex", tex: true, text: "Tex changed the group photo." }),
    row({ id: "4", who: "Tex", tex: true, reply: "1", text: "(sent with Confetti) Done!\n\n(poll) Which day?\n- Fri\n- Sat" }),
  ];
  const entries = chatEntries(rows, { as: "Beta Chen", running: null, now: at });

  test("running the group is an event line, the photo one with the picture it set", () => {
    const events = entries.filter((e) => e.t === "event");
    expect(events.map((e) => (e.t === "event" ? e.text : ""))).toEqual(["Tex named the conversation “Lisbon trip”.", "Tex changed the group photo."]);
    expect(events[1]!.t === "event" && events[1]!.photo).toBe("https://example.com/p.jpg");
  });

  test("Tex's bubbles carry the effect and the poll, never the marks", () => {
    const tex = entries.flatMap((e) => (e.t === "run" && e.tex ? e.items : []));
    expect(tex.map((b) => [b.text, b.effect ?? null, b.poll?.choices ?? null])).toEqual([
      ["Done!", "Confetti", null],
      ["Which day?", null, ["Fri", "Sat"]],
    ]);
  });

  test("a person's typed @Tex stays their words", () => {
    const theirs = entries.flatMap((e) => (e.t === "run" && !e.tex ? e.items : [])).find((b) => b.kind === "text");
    expect(theirs?.text).toBe("@Tex call this chat Lisbon trip and make this the photo");
  });
});
