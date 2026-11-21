/**
 * Tex in a note: the endpoint derivation, the NDJSON reader, the event parser,
 * the run and the log's fetch, and the facet the editor reads.
 *
 * Sabotage (2026-11-20): removing the one re-mint in `withGrant` (the 401/403
 * retry) made "re-mints once on 401 with a fresh grant" and "a second refusal
 * is what the caller gets" fail, and nothing else. Restored, all green.
 *
 * @jest-environment node
 */
import { describe, expect, it } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { texInNoteHost, type NoteRunEvent, type NoteRunRequest, type TexInNoteHost } from "../features/console/files/comments/tex/contract";
import {
  STOPPED_RUN,
  UNREACHABLE_RUN,
  READ_FAILED,
  emptyLogSentence,
  fetchNoteRuns,
  noteRunEndpoint,
  noteRunsEndpoint,
  parseEvent,
  readNdjson,
  runNoteRun,
  texInNoteExtension,
} from "../features/console/files/comments/tex/noteRun";

const ROUTE = "https://ctx.example/tex/note-run";
const RUNS_ROUTE = "https://ctx.example/tex/note-runs";

const REQUEST: NoteRunRequest = {
  workspace: "ws_1",
  noteId: "note_1",
  path: "1-projects/plan.md",
  thread: "t1",
  anchor: { text: "budget", before: "the ", after: " line" },
  ask: "tighten this",
  history: [],
  pending: null,
};

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Every byte its own chunk: the harshest split a network can make. */
function byteChunks(text: string): Uint8Array[] {
  return [...new TextEncoder().encode(text)].map((byte) => Uint8Array.of(byte));
}

function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function streamResponse(text: string, status = 200): Response {
  return new Response(streamOf(byteChunks(text)), { status, headers: { "content-type": "application/x-ndjson" } });
}

/** Mints tokens t1, t2, ... and records every call, so a test can see the re-mint. */
function mintSequence() {
  const calls: unknown[] = [];
  let n = 0;
  const mint = async (refresh: unknown) => {
    calls.push(refresh);
    n += 1;
    return `t${n}`;
  };
  return { mint, calls };
}

async function collect(stream: AsyncIterable<NoteRunEvent>): Promise<NoteRunEvent[]> {
  const out: NoteRunEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("endpoint derivation", () => {
  it("takes the origin of the MCP endpoint and nothing else", () => {
    expect(noteRunEndpoint("https://ctx.example/mcp?token=x")).toBe(ROUTE);
    expect(noteRunsEndpoint("https://ctx.example/some/path")).toBe(RUNS_ROUTE);
    expect(noteRunEndpoint("http://localhost:8787/mcp")).toBe("http://localhost:8787/tex/note-run");
  });

  it("is null for a bad URL and for any scheme but http and https", () => {
    expect(noteRunEndpoint("not a url")).toBeNull();
    expect(noteRunsEndpoint("ftp://ctx.example/mcp")).toBeNull();
    expect(noteRunEndpoint("javascript:alert(1)")).toBeNull();
  });
});

describe("readNdjson", () => {
  it("yields each line across any chunk boundary, including inside a multi-byte character", async () => {
    const text = ndjson([
      { type: "answer", text: "“quoted” — done" },
      { type: "step", id: "a", label: "Reading", state: "running" },
    ]);
    const seen: unknown[] = [];
    for await (const value of readNdjson(streamOf(byteChunks(text)))) seen.push(value);
    expect(seen).toEqual([
      { type: "answer", text: "“quoted” — done" },
      { type: "step", id: "a", label: "Reading", state: "running" },
    ]);
  });

  it("skips blank lines and reads a last line with no newline", async () => {
    const seen: unknown[] = [];
    for await (const value of readNdjson(streamOf(byteChunks('\n{"type":"answer","text":"a"}\n\n{"type":"done","runId":"r"}')))) {
      seen.push(value);
    }
    expect(seen).toEqual([{ type: "answer", text: "a" }, { type: "done", runId: "r" }]);
  });

  it("ends with one error for a line that is not JSON, and reads nothing after it", async () => {
    const seen: unknown[] = [];
    for await (const value of readNdjson(streamOf(byteChunks('{"type":"answer","text":"a"}\nnot json\n{"type":"done","runId":"r"}\n')))) {
      seen.push(value);
    }
    expect(seen).toEqual([
      { type: "answer", text: "a" },
      { type: "error", message: "Tex sent something this app can't read." },
    ]);
  });
});

describe("parseEvent", () => {
  it("reads each event by name and drops fields it does not name", () => {
    expect(parseEvent({ type: "step", id: "s", label: "Searched", state: "done", ms: 12, source: "notes", secret: "x" })).toEqual({
      type: "step",
      id: "s",
      label: "Searched",
      state: "done",
      ms: 12,
      source: "notes",
    });
    expect(parseEvent({ type: "done", runId: "r", sources: ["a", 3, "b"], extra: true })).toEqual({
      type: "done",
      runId: "r",
      sources: ["a", "b"],
    });
  });

  it("rejects bad shapes and unknown types", () => {
    expect(parseEvent({ type: "step", id: "s", label: "x", state: "half" })).toBeNull();
    expect(parseEvent({ type: "answer", text: 5 })).toBeNull();
    expect(parseEvent({ type: "edit" })).toBeNull();
    expect(parseEvent({ type: "done" })).toBeNull();
    expect(parseEvent({ type: "error", message: null })).toBeNull();
    expect(parseEvent({ type: "telemetry", n: 1 })).toBeNull();
    expect(parseEvent(["answer"])).toBeNull();
    expect(parseEvent(null)).toBeNull();
  });
});

describe("runNoteRun", () => {
  it("posts the request with a Bearer grant and yields the stream's events in order", async () => {
    const { mint, calls } = mintSequence();
    let sent: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return streamResponse(
        ndjson([
          { type: "step", id: "a", label: "Reading", state: "running" },
          { type: "edit", replace: "new words" },
          { type: "answer", text: "Done." },
          { type: "done", runId: "run_1", sources: ["plan.md"] },
        ]),
      );
    }) as unknown as typeof fetch;
    const events = await collect(
      runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }),
    );
    expect(events).toEqual([
      { type: "step", id: "a", label: "Reading", state: "running" },
      { type: "edit", replace: "new words" },
      { type: "answer", text: "Done." },
      { type: "done", runId: "run_1", sources: ["plan.md"] },
    ]);
    expect(calls).toEqual([false]);
    expect(sent!.url).toBe(ROUTE);
    expect(sent!.init.method).toBe("POST");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer t1");
    expect(JSON.parse(sent!.init.body as string)).toEqual(REQUEST);
  });

  it("re-mints once on 401 with the refused token, and sends the second answer", async () => {
    const { mint, calls } = mintSequence();
    const tokens: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      tokens.push((init.headers as Record<string, string>).Authorization);
      if (tokens.length === 1) return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      return streamResponse(ndjson([{ type: "done", runId: "r", sources: [] }]));
    }) as unknown as typeof fetch;
    const events = await collect(runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }));
    expect(calls).toEqual([false, { rejected: "t1" }]);
    expect(tokens).toEqual(["Bearer t1", "Bearer t2"]);
    expect(events).toEqual([{ type: "done", runId: "r", sources: [] }]);
  });

  it("gives the caller the second refusal and does not loop", async () => {
    const { mint, calls } = mintSequence();
    const fetchImpl = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const events = await collect(runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }));
    expect(calls).toHaveLength(2);
    expect(events).toEqual([{ type: "error", message: "You can't ask Tex about this note." }]);
  });

  it("maps refusals to a sentence by status, preferring a short server error", async () => {
    const cases: [number, unknown, string][] = [
      [400, { error: "Pick a note first." }, "Pick a note first."],
      [400, null, "Tex couldn't read this request."],
      [429, null, "Tex is busy. Try again in a minute."],
      [503, { error: "x".repeat(250) }, "Tex isn't available right now."],
      [500, null, "Tex didn't answer. Try again."],
    ];
    for (const [status, body, sentence] of cases) {
      const { mint } = mintSequence();
      const fetchImpl = (async () =>
        new Response(body === null ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;
      const events = await collect(runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }));
      expect(events).toEqual([{ type: "error", message: sentence }]);
    }
  });

  it("yields an error when the stream ends without done or error", async () => {
    const { mint } = mintSequence();
    const fetchImpl = (async () =>
      streamResponse(ndjson([{ type: "answer", text: "half" }]))) as unknown as typeof fetch;
    const events = await collect(runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }));
    expect(events).toEqual([
      { type: "answer", text: "half" },
      { type: "error", message: STOPPED_RUN },
    ]);
  });

  it("says it could not reach Tex when the network fails, and never throws", async () => {
    const { mint } = mintSequence();
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const events = await collect(runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: new AbortController().signal, fetchImpl }));
    expect(events).toEqual([{ type: "error", message: UNREACHABLE_RUN }]);
    const failingMint = async () => {
      throw new Error("mint refused: https://secret.example/token");
    };
    const minted = await collect(
      runNoteRun({ route: ROUTE, mint: failingMint, request: REQUEST, signal: new AbortController().signal, fetchImpl }),
    );
    expect(minted).toEqual([{ type: "error", message: UNREACHABLE_RUN }]);
  });

  it("stops silently when the signal aborts mid-stream", async () => {
    const { mint } = mintSequence();
    const fetchImpl = ((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"answer","text":"part"}\n'));
          signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const seen: NoteRunEvent[] = [];
    for await (const event of runNoteRun({ route: ROUTE, mint, request: REQUEST, signal: controller.signal, fetchImpl })) {
      seen.push(event);
      controller.abort();
    }
    expect(seen).toEqual([{ type: "answer", text: "part" }]);
  });
});

describe("fetchNoteRuns", () => {
  it("encodes the workspace and note in the query and parses rows by name", async () => {
    const { mint } = mintSequence();
    let url = "";
    const fetchImpl = (async (requested: string) => {
      url = requested;
      return new Response(
        JSON.stringify({
          runs: [
            {
              runId: "run_1",
              who: "@sayo",
              ask: "tighten",
              out: "Shortened the budget line.",
              sources: ["budget.md", 7],
              at: "2026-11-20T10:00:00.000Z",
              private: false,
              internal: "dropped",
            },
            { runId: "run_2", who: "@seyi", ask: "x", out: "y", at: "2026-11-20T11:00:00.000Z" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const rows = await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "a b&c", noteId: "n/1", fetchImpl });
    expect(url).toBe(`${RUNS_ROUTE}?workspace=a%20b%26c&noteId=n%2F1`);
    expect(rows).toEqual([
      {
        runId: "run_1",
        who: "@sayo",
        ask: "tighten",
        out: "Shortened the budget line.",
        sources: ["budget.md"],
        at: "2026-11-20T10:00:00.000Z",
        private: false,
      },
      // A row that does not say it is private is drawn as private: the safer line to be wrong on.
      { runId: "run_2", who: "@seyi", ask: "x", out: "y", sources: [], at: "2026-11-20T11:00:00.000Z", private: true },
    ]);
  });

  it("fails the whole read on one unreadable row, and says why a refusal refused", async () => {
    const { mint } = mintSequence();
    const bad = (async () =>
      new Response(JSON.stringify({ runs: [{ runId: "r", who: "@a", ask: "x", out: "y", at: 5 }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "n", fetchImpl: bad })).toEqual({ error: READ_FAILED });
    const forbidden = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "n", fetchImpl: forbidden })).toEqual({
      error: "You can't read Tex's log for this note.",
    });
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "n", fetchImpl: down })).toEqual({ error: UNREACHABLE_RUN });
  });

  it("marks Tex in notes as off when the route is missing or switched off, so no button is offered", async () => {
    const { mint } = mintSequence();
    const notOn = (async () =>
      new Response(JSON.stringify({ error: "Tex in notes isn't on yet." }), { status: 503 })) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "", path: "a.md", fetchImpl: notOn })).toMatchObject({ off: true });
    const missing = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "", fetchImpl: missing })).toMatchObject({ off: true });
    const forbidden = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    expect(await fetchNoteRuns({ route: RUNS_ROUTE, mint, workspace: "w", noteId: "", fetchImpl: forbidden })).not.toHaveProperty("off");
  });
});

describe("the empty log and the facet", () => {
  it("names the shortcut for the platform", () => {
    expect(emptyLogSentence(true)).toBe(
      "Highlight text and choose Ask Tex, or press ⌘L at your cursor. Runs here stay with the note and never land in your Tex chat.",
    );
    expect(emptyLogSentence(false)).toContain("press Ctrl+L at your cursor.");
  });

  it("installs the Tex facet only while a host is there, and forwards to the host it reads", async () => {
    const absent = EditorState.create({ extensions: [texInNoteExtension(() => null)] });
    expect(absent.facet(texInNoteHost)).toBeNull();

    const seen: string[] = [];
    let current: TexInNoteHost | null = {
      run: async function* () {},
      runs: async () => [],
      note: () => ({ workspace: "w", noteId: "n", path: "p.md" }),
      people: () => [],
      onRunning: (running) => seen.push(`running:${running}`),
    };
    const present = EditorState.create({ extensions: [texInNoteExtension(() => current)] });
    const host = present.facet(texInNoteHost)!;
    expect(host).not.toBeNull();
    // The host is read at call time, so one that changes is the one reached.
    host.onRunning?.(true);
    current = null;
    expect(host.note()).toBeNull();
    expect(await host.runs()).toEqual({ error: "Tex isn't available right now." });
    expect(seen).toEqual(["running:true"]);
  });
});
