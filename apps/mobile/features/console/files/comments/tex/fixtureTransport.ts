/**
 * A pretend gateway for Tex in a note, for the browser fixture alone
 * (`/e2e-fixture?tex=fake`, `features/e2e/FixtureScreen.tsx`).
 *
 * The fixture console runs on demo data, which has no Tex to reach, so
 * `useTexInNote` offers no Tex there. With this set, it takes the fixture's
 * target and sends its requests to `fakeNoteRunFetch` instead of the network:
 * the real `runNoteRun` and `fetchNoteRuns` read a real NDJSON stream and a
 * real JSON log, so the browser test proves the editor's whole path from the
 * Tex button to Keep, only the far end being invented. Nothing sets it outside
 * that fixture screen, which renders only in a build made with
 * `EXPO_PUBLIC_E2E_FIXTURE=1`.
 */

import type { NoteRunRow } from "./contract";

export interface TexInNoteFixture {
  target: { workspaceId: string; endpoint: string };
  fetchImpl: typeof fetch;
}

let fixture: TexInNoteFixture | null = null;

export function setTexInNoteFixture(value: TexInNoteFixture | null): void {
  fixture = value;
}

export function texInNoteFixture(): TexInNoteFixture | null {
  return fixture;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scripted Tex: two steps, then a rewrite of the highlighted words and
 * a short answer, then `done`. Asks are kept so the log lists them, newest
 * first, like the gateway's.
 */
export function fakeNoteRunFetch(options: { stepMs?: number } = {}): TexInNoteFixture {
  const stepMs = options.stepMs ?? 600;
  const runs: NoteRunRow[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/tex/note-runs")) {
      return new Response(JSON.stringify({ runs }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { ask?: string; anchor?: { text?: string }; path?: string };
    const words = body.anchor?.text ?? "";
    // A true rewrite, never the words with more after them, so the test sees the old words struck.
    const replace = words === "" ? "Added by Tex." : `Checked by Tex: ${words.replace(/[.\s]+$/, "")}.`;
    const answer = words === "" ? "Added a line at your cursor. Keep or undo?" : "Rewrote the highlighted words. Keep or undo?";
    const runId = `fixture-${runs.length + 1}`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        line({ type: "step", id: "1", label: "Reading this note", state: "running" });
        await sleep(stepMs);
        line({ type: "step", id: "1", label: "Reading this note", state: "done", ms: stepMs });
        line({ type: "step", id: "2", label: "Editing", state: "running" });
        await sleep(stepMs / 2);
        line({ type: "step", id: "2", label: "Editing", state: "done", ms: stepMs / 2 });
        line({ type: "edit", replace });
        line({ type: "answer", text: answer });
        runs.unshift({ runId, who: "@seyi", ask: body.ask ?? "", out: answer, sources: [body.path ?? "this note"], at: new Date().toISOString(), private: false });
        line({ type: "done", runId, sources: [body.path ?? "this note"] });
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as typeof fetch;
  return { target: { workspaceId: "fixture", endpoint: "https://fixture.invalid/mcp" }, fetchImpl };
}
