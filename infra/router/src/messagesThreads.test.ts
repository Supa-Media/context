/**
 * A chat's live view of its jobs (`messagesThreads.ts`): read from the
 * texting Worker with the link's token, every word escaped, no script, and
 * the same "ended" page for every miss.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `jobBlock` setting a title unescaped → "never lets a title write markup" fails.
 *   `threadsResponse` fetching with a key it did not check → "a malformed key asks the Worker nothing" fails.
 */

import { describe, expect, it } from "vitest";

import { readView, threadsResponse } from "./messagesThreads";

const OBJECT = "a".repeat(64);
const TOKEN = "b".repeat(64);
const NOW = 10_000_000;

function texts(answer: Response | (() => never), seen: string[] = []): { TEXTS: Fetcher } {
  return {
    TEXTS: {
      fetch: async (input: RequestInfo | URL) => {
        seen.push(String(input));
        if (typeof answer === "function") answer();
        return (answer as Response).clone();
      },
    } as unknown as Fetcher,
  };
}

async function view(query: string, env: { TEXTS?: Fetcher }): Promise<{ status: number; html: string; headers: Headers }> {
  const url = new URL(`https://context.lc/messages/threads${query}`);
  const response = (await threadsResponse(new Request(url), url, env))!;
  return { status: response.status, html: await response.text(), headers: response.headers };
}

const JOBS = {
  now: NOW,
  max: 3,
  jobs: [
    { title: "<b>Venues</b>", state: "running", startedAt: NOW - 4 * 60_000, status: "Checked 6 of 10", steps: [{ at: NOW - 60_000, text: "search: venues <near> me" }] },
    { title: "Gift ideas", state: "done", startedAt: NOW - 3_600_000, finishedAt: NOW - 600_000, steps: [] },
  ],
};

describe("a chat's live view", () => {
  it("lists each job with its state, status and steps, the running one open, and reloads while one runs", async () => {
    const seen: string[] = [];
    const page = await view(`?k=${OBJECT}.${TOKEN}`, texts(Response.json(JOBS), seen));
    expect(seen).toEqual([`https://texts/threads/${OBJECT}/${TOKEN}`]);
    expect(page.status).toBe(200);
    expect(page.html).toContain("1 of 3 running");
    expect(page.html).toContain("Checked 6 of 10");
    expect(page.html).toContain("4 min so far");
    expect(page.html).toContain("done 10 min ago");
    expect(page.html).toMatch(/<details open>/);
    expect(page.html).toContain('http-equiv="refresh"');
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(page.headers.get("Content-Security-Policy")).not.toContain("script-src");
    expect(page.html).not.toContain("<script");
  });

  it("never lets a title or a step write markup", async () => {
    const page = await view(`?k=${OBJECT}.${TOKEN}`, texts(Response.json(JOBS)));
    expect(page.html).toContain("&lt;b&gt;Venues&lt;/b&gt;");
    expect(page.html).toContain("venues &lt;near&gt; me");
    expect(page.html).not.toContain("<b>Venues");
  });

  it("does not reload once nothing runs", async () => {
    const page = await view(`?k=${OBJECT}.${TOKEN}`, texts(Response.json({ ...JOBS, jobs: [JOBS.jobs[1]] })));
    expect(page.html).toContain("0 of 3 running");
    expect(page.html).not.toContain("refresh");
  });

  it("a malformed key asks the Worker nothing; a refused, broken or missing Worker shows the same ended page", async () => {
    const seen: string[] = [];
    for (const query of ["", "?k=nope", `?k=${OBJECT}`, `?k=${OBJECT}.${TOKEN}.x`, `?k=${OBJECT.toUpperCase()}.${TOKEN}`]) {
      expect((await view(query, texts(Response.json(JOBS), seen))).html).toContain("This view has ended");
    }
    expect(seen).toEqual([]);
    for (const env of [texts(new Response(null, { status: 404 })), texts(() => { throw new Error("down"); }), texts(new Response("not json")), {}]) {
      const page = await view(`?k=${OBJECT}.${TOKEN}`, env);
      expect(page.status).toBe(200);
      expect(page.html).toContain("This view has ended");
    }
  });

  it("is only this path, and only GET", async () => {
    const url = new URL("https://context.lc/messages/pick");
    expect(await threadsResponse(new Request(url), url, {})).toBeNull();
    const post = new URL(`https://context.lc/messages/threads?k=${OBJECT}.${TOKEN}`);
    expect((await threadsResponse(new Request(post, { method: "POST" }), post, {}))!.status).toBe(405);
  });
});

describe("the Worker's answer", () => {
  it("drops anything malformed rather than showing it", () => {
    expect(readView(null)).toBeNull();
    expect(readView({ jobs: [] })).toBeNull();
    const read = readView({ now: NOW, max: 999, jobs: [{ title: "", state: "running", startedAt: 1 }, { title: "x", state: "weird", startedAt: 1 }, { title: "ok", state: "failed", startedAt: 1, steps: [{ at: "x", text: "y" }, { at: 2, text: "z" }] }] });
    expect(read).toEqual({ now: NOW, max: 3, jobs: [{ title: "ok", state: "failed", startedAt: 1, steps: [{ at: 2, text: "z" }] }] });
  });
});
