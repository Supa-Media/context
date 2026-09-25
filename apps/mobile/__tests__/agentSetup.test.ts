import { describe, expect, test } from "@jest/globals";

/**
 * The guided Claude/ChatGPT setup, as rules: which steps, what the prompt
 * says, and — because the guide moves on by itself — exactly when it does.
 *
 * Every "done" here is read from a fact the product already records (a grant,
 * an agent-activity mark), never from a click. The one step nothing can see,
 * "Make it stick", takes the person's word and is the only one that does.
 */

import { bringPrompt, DEFAULT_TOPICS } from "../features/agentSetup/bring";
import {
  agentMarks,
  agentUsed,
  bringState,
  mergeWritten,
  NOTHING_AFTER_MS,
  NO_WRITE_AFTER_MS,
  notePlace,
  noteTitle,
  onlyGettingStarted,
  signedIn,
  SIGNIN_SLOW_AFTER_MS,
} from "../features/agentSetup/checks";
import { agentFromQuery, clampStep, GUIDE_STEPS } from "../features/agentSetup/guides";
import { bringView, openingStep, signinState, tileState } from "../features/agentSetup/guideState";
import {
  decodeProgress,
  encodeProgress,
  FRESH_PROGRESS,
  progressKey,
  type SetupProgress,
} from "../features/agentSetup/progress";
import { CLAUDE_CUSTOM_INSTRUCTION } from "../features/onboarding/agents";
import { CONSOLE_CLIENT_ID, type GrantFacts } from "../features/onboarding/tools";
import type { AgentActivityView } from "../features/console/agents/agentActivity";

const T0 = 1_700_000_000_000;
const claudeGrant = (over: Partial<GrantFacts> = {}): GrantFacts =>
  ({ clientId: "c-claude", clientName: "Claude", status: "active", lastUsedAt: null, ...over }) as GrantFacts;
const gptGrant = (over: Partial<GrantFacts> = {}): GrantFacts =>
  ({ clientId: "c-gpt", clientName: "ChatGPT", status: "active", lastUsedAt: null, ...over }) as GrantFacts;
const progress = (over: Partial<SetupProgress> = {}): SetupProgress => ({ ...FRESH_PROGRESS, ...over });

function activity(marks: Array<{ path: string; kind: "read" | "write"; at: number; agent?: string }>): AgentActivityView {
  return {
    agents: [
      { id: "a-claude", name: "Claude" },
      { id: "a-cursor", name: "Cursor" },
    ],
    marks: marks.map((mark) => ({ agent: "a-claude", ...mark })),
  } as unknown as AgentActivityView;
}

describe("the steps", () => {
  test("Claude: the app only — no picker, no Claude Code — and both end on stick, then bring", () => {
    expect(GUIDE_STEPS.claude).toEqual(["open", "add", "signin", "stick", "bring"]);
    expect(GUIDE_STEPS.chatgpt).toEqual(["devmode", "create", "signin", "stick", "bring"]);
  });

  test("the query names an agent we wrote, or nothing", () => {
    expect(agentFromQuery("claude")).toBe("claude");
    expect(agentFromQuery(["chatgpt"])).toBe("chatgpt");
    expect(agentFromQuery("claude-code")).toBeNull();
    expect(agentFromQuery(undefined)).toBeNull();
  });

  test("saved steps never point past the end", () => {
    expect(clampStep("claude", 99)).toBe(4);
    expect(clampStep("claude", -1)).toBe(0);
    expect(clampStep("claude", Number.NaN)).toBe(0);
  });

  test("make it stick hands over the one standing instruction every guide shares", () => {
    expect(CLAUDE_CUSTOM_INSTRUCTION).toMatch(/call orient/);
    expect(CLAUDE_CUSTOM_INSTRUCTION).toMatch(/save_context/);
  });
});

describe("the bring-over prompt", () => {
  test("names the workspace, keeps the guardrails, and always ends with a note to write", () => {
    const prompt = bringPrompt("supa", DEFAULT_TOPICS);
    expect(prompt).toContain("my @supa workspace");
    expect(prompt).toContain("Call orient first");
    expect(prompt).toContain("my work and projects, the people I work with (names and roles only) and how I like to work");
    expect(prompt).not.toContain("personal life");
    expect(prompt).toContain("wait for my go");
    expect(prompt).toContain("don't touch index.md or privacy.md");
    expect(prompt).toMatch(/Finish with a note called "Getting started"/);
  });

  test("with nothing picked it still writes Getting started, so the check can pass", () => {
    const prompt = bringPrompt("seyi", []);
    expect(prompt).not.toContain("From what you remember");
    expect(prompt).toContain("Getting started");
  });
});

describe("what the guide can see", () => {
  test("signed in is a live grant matched by name; the console's own never counts", () => {
    expect(signedIn("claude", [claudeGrant()])).toBe(true);
    expect(signedIn("claude", [claudeGrant({ status: "revoked" } as Partial<GrantFacts>)])).toBe(false);
    expect(signedIn("claude", [gptGrant()])).toBe(false);
    expect(signedIn("chatgpt", [gptGrant()])).toBe(true);
    expect(signedIn("claude", [claudeGrant({ clientId: CONSOLE_CLIENT_ID })])).toBe(false);
    expect(signedIn("claude", undefined)).toBe(false);
  });

  test("used means it has called in, not just signed in", () => {
    expect(agentUsed("claude", [claudeGrant()])).toBe(false);
    expect(agentUsed("claude", [claudeGrant({ lastUsedAt: T0 })])).toBe(true);
  });

  test("only this agent's marks since the prompt was copied", () => {
    const view = activity([
      { path: "index.md", kind: "read", at: T0 - 1 },
      { path: "index.md", kind: "read", at: T0 + 1 },
      { path: "1-projects/a.md", kind: "write", at: T0 + 2 },
      { path: "1-projects/cursor.md", kind: "write", at: T0 + 3, agent: "a-cursor" },
    ]);
    const marks = agentMarks("claude", view, T0);
    expect(marks.reads).toBe(1);
    expect(marks.writes).toEqual([{ path: "1-projects/a.md", at: T0 + 2 }]);
  });

  test("notes seen stay seen after the gateway forgets them, in first-seen order", () => {
    const seen = [{ path: "a.md", at: 1 }];
    expect(mergeWritten(seen, [{ path: "b.md", at: 2 }, { path: "a.md", at: 3 }])).toEqual([
      { path: "a.md", at: 3 },
      { path: "b.md", at: 2 },
    ]);
  });

  test("waiting, reading, writing, and the two stalls — each at its own time", () => {
    expect(bringState({ copiedAt: null, now: T0, reads: 0, written: [] }).kind).toBe("ready");
    expect(bringState({ copiedAt: T0, now: T0 + 1, reads: 0, written: [] }).kind).toBe("waiting");
    expect(bringState({ copiedAt: T0, now: T0 + NOTHING_AFTER_MS, reads: 0, written: [] }).kind).toBe(
      "stalled-nothing",
    );
    expect(bringState({ copiedAt: T0, now: T0 + 1, reads: 2, written: [] }).kind).toBe("reading");
    expect(bringState({ copiedAt: T0, now: T0 + NO_WRITE_AFTER_MS, reads: 2, written: [] }).kind).toBe(
      "stalled-no-write",
    );
    expect(bringState({ copiedAt: T0, now: T0 + NO_WRITE_AFTER_MS, reads: 2, written: [{ path: "a.md", at: 1 }] }).kind).toBe(
      "writing",
    );
  });

  test("a run that only wrote Getting started had little to bring", () => {
    expect(onlyGettingStarted([{ path: "0-inbox/getting-started.md", at: 1 }])).toBe(true);
    expect(onlyGettingStarted([{ path: "0-inbox/getting-started.md", at: 1 }, { path: "a.md", at: 2 }])).toBe(false);
    expect(onlyGettingStarted([])).toBe(false);
  });

  test("a note's name is drawn the way the tree draws it, and contained", () => {
    expect(noteTitle("2-areas/people/olumide.md")).toBe("olumide");
    expect(notePlace("1-projects/context-lc.md")).toBe("projects/context-lc.md");
    // An agent chose this path: a direction override in it must not spill.
    expect(noteTitle("0-inbox/\u202Eevil.md")).not.toBe("\u202Eevil");
  });
});

describe("when the guide moves on", () => {
  test("sign-in: waiting, then slow, then done the moment the grant lands", () => {
    expect(signinState("claude", [], T0, T0 + 1)).toBe("waiting");
    expect(signinState("claude", [], T0, T0 + SIGNIN_SLOW_AFTER_MS)).toBe("slow");
    expect(signinState("claude", [claudeGrant()], T0, T0 + 1)).toBe("done");
  });

  test("an agent already signed in skips to make it stick; a later saved step is kept", () => {
    expect(openingStep("claude", progress({ step: 0 }), [claudeGrant()])).toBe(3);
    expect(openingStep("claude", progress({ step: 0 }), [])).toBe(0);
    expect(openingStep("claude", progress({ step: 4 }), [claudeGrant()])).toBe(4);
    expect(openingStep("chatgpt", progress({ finished: true }), [gptGrant()])).toBe(4);
  });

  test("bring: pick, then live, then done when Getting started arrives", () => {
    const base = { agent: "claude" as const, grants: [claudeGrant({ lastUsedAt: T0 })], now: T0 + 1000 };
    expect(bringView({ ...base, progress: progress({ step: 4 }), activity: undefined }).kind).toBe("pick");

    const live = bringView({
      ...base,
      progress: progress({ step: 4, copiedAt: T0 }),
      activity: activity([
        { path: "index.md", kind: "read", at: T0 + 1 },
        { path: "1-projects/a.md", kind: "write", at: T0 + 2 },
      ]),
    });
    expect(live.kind).toBe("live");
    if (live.kind === "live") {
      expect(live.signedIn).toBe(true);
      expect(live.state.kind).toBe("writing");
      expect(live.written.map((row) => row.path)).toEqual(["1-projects/a.md"]);
    }

    const done = bringView({
      ...base,
      progress: progress({ step: 4, copiedAt: T0, written: [{ path: "1-projects/a.md", at: T0 + 2 }] }),
      activity: activity([{ path: "0-inbox/getting-started.md", kind: "write", at: T0 + 9 }]),
    });
    expect(done.kind).toBe("done");

    const little = bringView({
      ...base,
      progress: progress({ step: 4, copiedAt: T0 }),
      activity: activity([{ path: "0-inbox/Getting started.md", kind: "write", at: T0 + 9 }]),
    });
    expect(little.kind).toBe("little");
  });

  test("the tile: set up, partway, connected — and a revoked grant is not connected", () => {
    expect(tileState("claude", undefined, [])).toEqual({ kind: "new" });
    expect(tileState("claude", progress({ step: 3 }), [])).toEqual({ kind: "partway", step: 4, of: 5 });
    expect(tileState("claude", undefined, [claudeGrant({ lastUsedAt: T0 })])).toEqual({ kind: "connected" });
    expect(tileState("claude", progress({ finished: true, step: 4 }), [claudeGrant()])).toEqual({ kind: "connected" });
    expect(tileState("claude", progress({ finished: true, step: 4 }), [])).toEqual({ kind: "new" });
  });
});

describe("saved progress", () => {
  test("one record per workspace and agent", () => {
    expect(progressKey("w1", "claude")).not.toBe(progressKey("w2", "claude"));
    expect(progressKey("w1", "claude")).not.toBe(progressKey("w1", "chatgpt"));
  });

  test("round-trips", () => {
    const saved = progress({ step: 2, topics: ["work"], copiedAt: T0, written: [{ path: "a.md", at: 1 }] });
    expect(decodeProgress("claude", encodeProgress(saved))).toEqual(saved);
  });

  test("anything unreadable is a fresh start, and bad fields are dropped, not trusted", () => {
    expect(decodeProgress("claude", "{not json")).toEqual(FRESH_PROGRESS);
    expect(decodeProgress("claude", "null")).toEqual(FRESH_PROGRESS);
    const odd = decodeProgress(
      "claude",
      JSON.stringify({ step: 42, topics: ["work", "secrets"], copiedAt: "soon", written: [{ path: 1 }, { path: "a.md", at: 2 }] }),
    );
    expect(odd.step).toBe(4);
    expect(odd.topics).toEqual(["work"]);
    expect(odd.copiedAt).toBeNull();
    expect(odd.written).toEqual([{ path: "a.md", at: 2 }]);
  });
});
