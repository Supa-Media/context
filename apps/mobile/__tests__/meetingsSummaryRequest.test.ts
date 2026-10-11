import { describe, expect, jest, test } from "@jest/globals";
import {
  automaticSummaryDue,
  requestSummary,
  summaryKey,
  summaryMessage,
  summaryRoute,
  type SummaryStatus,
} from "../features/meetings/summaryRequest";

/**
 * THE SUMMARY REQUEST, AS THE APP SENDS IT.
 *
 * The gateway writes the summary into the note; the app asks and says what
 * came back. These tests pin the route, the body, the bearer, every status the
 * gateway can give, and the rule that a failure is always one short line rather
 * than a thrown error.
 */

const ORIGIN = "https://gateway.example";
const TOKEN = "token-for-tests";
const PATH = "1-projects/standup.md";

/** A fetch that answers once with `body` and `status`, and records what it was asked. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function sentBody(calls: { init: RequestInit }[]): Record<string, unknown> {
  return JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
}

describe("summaryRoute", () => {
  test("is the gateway origin with the summary route, whatever path the endpoint carries", () => {
    expect(summaryRoute("https://gateway.example/mcp")).toBe("https://gateway.example/meetings/summary");
    expect(summaryRoute("https://gateway.example/mcp?x=1")).toBe("https://gateway.example/meetings/summary");
  });

  test("is null for an endpoint that is not a URL", () => {
    expect(summaryRoute("not a url")).toBeNull();
    expect(summaryRoute("")).toBeNull();
  });
});

describe("requestSummary: the request", () => {
  test("posts the path and force flag to the summary route with the bearer", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { status: "written" });
    await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example/meetings/summary");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(sentBody(calls)).toEqual({ path: PATH, force: false });
  });

  test("sends force true for Redo", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { status: "written" });
    await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: true });
    expect(sentBody(calls)).toEqual({ path: PATH, force: true });
  });

  test("sends the instruction trimmed, and leaves it out when it is blank", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { status: "written" });
    await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: true, instruction: "  Just action items \n" });
    expect(sentBody(calls).instruction).toBe("Just action items");

    const blank = fakeFetch(200, { status: "written" });
    await requestSummary({ fetchImpl: blank.fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: true, instruction: "   " });
    expect(sentBody(blank.calls)).toEqual({ path: PATH, force: true });
  });

  test("caps the instruction at 500 characters", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { status: "written" });
    await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: true, instruction: "x".repeat(900) });
    expect((sentBody(calls).instruction as string).length).toBe(500);
  });
});

describe("requestSummary: the answer", () => {
  const statuses: SummaryStatus[] = ["written", "skipped", "recording", "waiting", "too_short", "unavailable", "conflict"];
  for (const status of statuses) {
    test(`returns ${status} as the gateway said it`, async () => {
      const { fetchImpl } = fakeFetch(200, { status });
      expect(await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).toBe(status);
    });
  }

  test("a non-200 answer is failed, whatever its body says", async () => {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      const { fetchImpl } = fakeFetch(status, { status: "written" });
      expect(await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).toBe("failed");
    }
  });

  test("a status the gateway did not name is failed", async () => {
    const { fetchImpl } = fakeFetch(200, { status: "exploded" });
    expect(await requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).toBe("failed");
  });

  test("a body that is not JSON, or not an object, is failed", async () => {
    const notJson = fakeFetch(200, "<html>proxy error</html>");
    expect(await requestSummary({ fetchImpl: notJson.fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).toBe("failed");
    const notObject = fakeFetch(200, ["written"]);
    expect(await requestSummary({ fetchImpl: notObject.fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).toBe("failed");
  });

  test("a fetch that throws is failed, and does not reject", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    await expect(requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false })).resolves.toBe("failed");
  });

  test("no answer before the timeout is failed, even from a fetch that ignores its signal", async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const pending = requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false, timeoutMs: 120_000 });
      jest.advanceTimersByTime(119_999);
      let settled = false;
      void pending.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(pending).resolves.toBe("failed");
    } finally {
      jest.useRealTimers();
    }
  });

  test("the timeout aborts the request it gave up on", async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = jest.fn((_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;
      const pending = requestSummary({ fetchImpl, origin: ORIGIN, token: TOKEN, path: PATH, force: false, timeoutMs: 1_000 });
      jest.advanceTimersByTime(1_000);
      await pending;
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("summaryMessage", () => {
  test("says nothing for a summary that was written or skipped", () => {
    expect(summaryMessage("written")).toBeNull();
    expect(summaryMessage("skipped")).toBeNull();
  });

  test("says one short plain sentence for each other status", () => {
    expect(summaryMessage("waiting")).toBe("Today's summaries are used up. This one will be written tomorrow.");
    expect(summaryMessage("too_short")).toBe("There wasn't enough said to summarize.");
    expect(summaryMessage("unavailable")).toBe("Summaries aren't available right now.");
    expect(summaryMessage("failed")).toBe("Couldn't write the summary. Try again in a moment.");
    expect(summaryMessage("conflict")).toBe("The note changed while the summary was being written. Try again.");
  });

  test("no message has an em dash in it", () => {
    const statuses: SummaryStatus[] = ["written", "skipped", "waiting", "too_short", "unavailable", "failed", "conflict"];
    for (const status of statuses) expect(summaryMessage(status) ?? "").not.toContain("—");
  });
});

/* ------------------------- the automatic summary ------------------------- */

/** A meeting note whose transcript is long enough to summarize, with `summary` in its Summary section. */
function meeting(summary: string, words = 60): string {
  const said = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  return [
    "---",
    'type: "meeting"',
    "---",
    "",
    "# Standup",
    "",
    "## Summary",
    "",
    summary,
    "",
    "## My notes",
    "",
    "## Transcript",
    "",
    said,
    "",
  ].join("\n");
}

const PLACEHOLDER = "_No summary yet._";
const WAITING = "_This meeting will be summarized tomorrow. Redo it then._";

describe("automaticSummaryDue", () => {
  const key = summaryKey("ws_1", PATH);
  const due = (overrides: Partial<Parameters<typeof automaticSummaryDue>[0]> = {}) =>
    automaticSummaryDue({ key, text: meeting(PLACEHOLDER), canEdit: true, pending: false, started: new Set(), ...overrides });

  test("is due for a meeting with no summary yet, that the person may edit", () => {
    expect(due()).toBe(true);
  });

  test("is due again for a waiting or failed summary, until the session has asked once", () => {
    expect(due({ text: meeting(WAITING) })).toBe(true);
    expect(due({ text: meeting("_Couldn't write a summary this time. Use Redo summary to try again._") })).toBe(true);
  });

  test("is not due once the session has already asked for this note", () => {
    expect(due({ started: new Set([key]) })).toBe(false);
  });

  test("is not due for another note in the same session", () => {
    expect(due({ started: new Set([summaryKey("ws_1", "1-projects/other.md")]) })).toBe(true);
    expect(due({ started: new Set([summaryKey("ws_2", PATH)]) })).toBe(true);
  });

  test("is not due while a request for it is pending", () => {
    expect(due({ pending: true })).toBe(false);
  });

  test("is not due for someone who may only read the note", () => {
    expect(due({ canEdit: false })).toBe(false);
  });

  test("is not due over a summary somebody wrote, by hand or by the model", () => {
    expect(due({ text: meeting("A short summary that a person wrote.") })).toBe(false);
  });

  test("is not due for a meeting with too little said to summarize", () => {
    expect(due({ text: meeting(PLACEHOLDER, 5) })).toBe(false);
  });

  test("is not due for a note that is not a meeting", () => {
    expect(due({ text: "# Plain note\n\nSome words here.\n" })).toBe(false);
  });

  test("does not change the set it reads", () => {
    const started = new Set<string>();
    due({ started });
    expect(started.size).toBe(0);
  });
});
