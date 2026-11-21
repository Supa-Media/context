/**
 * THE RUN CARD'S WORDS.
 *
 * `appChatRun.ts` holds every string and number a Tex run card and a person's
 * delivery line show, so these tests pin the mock's wording and the icon
 * mapping without a renderer. Thinking never counts as a step.
 */

import { describe, expect, test } from "@jest/globals";
import {
  QUEUED_SENTENCE,
  STOPPED_TOAST,
  TRY_AGAIN,
  deliveryWord,
  failedSentence,
  runHead,
  secsLabel,
  stepCount,
  stepIcon,
  stepWords,
  type LiveStep,
  type RunCardData,
} from "../features/tex/chat/appChatRun";

const tool = (name: string, what?: string, extra: Partial<LiveStep> = {}): LiveStep => ({
  k: "tool",
  at: 0,
  name,
  ...(what === undefined ? {} : { what }),
  ...extra,
});
const think = (text: string): LiveStep => ({ k: "think", at: 0, text });

describe("stepIcon", () => {
  test.each<[LiveStep, string]>([
    [think("hmm"), "brain"],
    [tool("search_notes"), "search"],
    [tool("search_email"), "mail"],
    [tool("search_mail"), "mail"],
    [tool("read_note"), "read"],
    [tool("fetch_page"), "read"],
    [tool("list_notes"), "read"],
    [tool("open_note"), "read"],
    [tool("write_note"), "write"],
    [tool("save_file"), "write"],
    [tool("edit_note"), "write"],
    [tool("update_note"), "write"],
    [tool("remember"), "write"],
    [tool("send_email"), "mail"],
    [tool("gmail_draft"), "mail"],
    [tool("browse_web"), "web"],
    [tool("url_lookup"), "web"],
    [tool("calendar_events"), "calendar"],
    [tool("ask_chat"), "chat"],
    [tool("send_text"), "chat"],
    [tool("background_job"), "hist"],
    [tool("job_status"), "hist"],
    [tool("frobnicate"), "tool"],
    [tool(""), "tool"],
  ])("%j maps to its icon", (step, icon) => {
    expect(stepIcon(step)).toBe(icon);
  });

  test("a context word is not a text message", () => {
    expect(stepIcon(tool("context_lookup"))).toBe("tool");
  });
});

describe("stepWords", () => {
  test("search_notes with a query reads as the mock does", () => {
    expect(stepWords(tool("search_notes", "bible study"))).toBe("Searched notes “bible study”");
  });

  test("a search with no query names only the thing searched", () => {
    expect(stepWords(tool("search_notes"))).toBe("Searched notes");
  });

  test("read_note and write_note", () => {
    expect(stepWords(tool("read_note", "Saturday party plan"))).toBe("Read “Saturday party plan”");
    expect(stepWords(tool("write_note", "Daniel 6 study"))).toBe("Wrote “Daniel 6 study”");
  });

  test("email search is named as mail", () => {
    expect(stepWords(tool("search_email", "from:puttery"))).toBe("Searched mail “from:puttery”");
  });

  test("a path keeps its last two segments", () => {
    expect(stepWords(tool("read_note", "areas/bible-study/Daniel 6 study.md"))).toBe(
      "Read “bible-study/Daniel 6 study.md”",
    );
    expect(stepWords(tool("write_note", "a/b/c/d.md"))).toBe("Wrote “c/d.md”");
  });

  test("a bare name is not trimmed", () => {
    expect(stepWords(tool("read_note", "Grocery list"))).toBe("Read “Grocery list”");
  });

  test("an unknown tool reads as Ran plus its name, with the object when there is one", () => {
    expect(stepWords(tool("frobnicate"))).toBe("Ran frobnicate");
    expect(stepWords(tool("frobnicate", "the thing"))).toBe("Ran frobnicate “the thing”");
  });

  test("a thinking step is its text", () => {
    expect(stepWords(think("I'll check their notes."))).toBe("I'll check their notes.");
    expect(stepWords({ k: "think", at: 0 })).toBe("");
  });
});

describe("stepCount", () => {
  test("counts tool steps and not thinking", () => {
    expect(stepCount([think("a"), tool("read_note"), tool("search_notes"), think("b")])).toBe(2);
  });

  test("zero for none", () => {
    expect(stepCount([])).toBe(0);
    expect(stepCount([think("only")])).toBe(0);
  });
});

describe("runHead", () => {
  const started = Date.UTC(2026, 10, 20, 8, 0, 0);

  test("live: the label is the run's now, and elapsed is rounded seconds", () => {
    const run: RunCardData = { live: true, startedAt: started, now: "Reading the note", steps: [] };
    expect(runHead(run, started + 12_400)).toEqual({ live: true, label: "Reading the note", elapsed: 12 });
  });

  test("live with no now: the last tool step's words", () => {
    const run: RunCardData = {
      live: true,
      startedAt: started,
      steps: [tool("read_note", "Daniel 5 study"), think("then")],
    };
    expect(runHead(run, started + 1_000)).toEqual({
      live: true,
      label: "Read “Daniel 5 study”",
      elapsed: 1,
    });
  });

  test("live with no steps and no now: Thinking", () => {
    const run: RunCardData = { live: true, startedAt: started, steps: [] };
    expect(runHead(run, started)).toEqual({ live: true, label: "Thinking", elapsed: 0 });
  });

  test("live with no start time: elapsed is 0, never negative", () => {
    const run: RunCardData = { live: true, steps: [] };
    const head = runHead(run, started);
    expect(head.live ? head.elapsed : -1).toBe(0);
    const late: RunCardData = { live: true, startedAt: started + 5_000, steps: [] };
    expect(runHead(late, started)).toMatchObject({ elapsed: 0 });
  });

  test("done: Worked and the step count, not the thinking", () => {
    const run: RunCardData = {
      live: false,
      secs: 41,
      steps: [think("a"), ...Array.from({ length: 7 }, (_, i) => tool("read_note", `n${i}`))],
    };
    expect(runHead(run, started)).toEqual({ live: false, label: "Worked 41s", steps: "7 steps" });
  });

  test("done with one step is singular", () => {
    const run: RunCardData = { live: false, secs: 3, steps: [tool("read_note")] };
    expect(runHead(run, started)).toEqual({ live: false, label: "Worked 3s", steps: "1 step" });
  });
});

describe("secsLabel", () => {
  test.each<[number, string]>([
    [0, "0.0s"],
    [40, "0.0s"],
    [400, "0.4s"],
    [1_240, "1.2s"],
    [1_260, "1.3s"],
    [9_940, "9.9s"],
    [9_960, "10s"],
    [12_000, "12s"],
    [94_000, "94s"],
  ])("%d ms reads %s", (ms, label) => {
    expect(secsLabel(ms)).toBe(label);
  });
});

describe("deliveryWord", () => {
  test.each<[Parameters<typeof deliveryWord>[0], string]>([
    ["sending", "Sending…"],
    ["sent", "Delivered"],
    ["reading", "Read"],
    ["read", "Read"],
    ["answered", "Answered"],
    ["stopped", "Stopped"],
    ["queued", "Delivered"],
    ["failed", ""],
  ])("%s reads %j", (state, word) => {
    expect(deliveryWord(state)).toBe(word);
  });
});

describe("sentences", () => {
  test("the failure sentence names the time it failed", () => {
    expect(failedSentence("8:25 AM")).toBe("Tex didn't answer this. It hit an error at 8:25 AM.");
  });

  test("the fixed words", () => {
    expect(TRY_AGAIN).toBe("Try again");
    expect(QUEUED_SENTENCE).toBe("Tex reads this as soon as it finishes the step it's on");
    expect(STOPPED_TOAST).toBe("Stopped. Tex keeps what it already did.");
  });
});
