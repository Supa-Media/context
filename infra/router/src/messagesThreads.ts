/**
 * The live view of a chat's background jobs (Dev2, 2026-10-29: a card that
 * shows the running threads, tapped to see what each is doing, in groups
 * too), at `/messages/threads?k=<object id>.<token>`.
 *
 * Tex sends the link when it starts a job or is asked what it is working on
 * (`apps/agent/src/jobs.ts` `mintThreadsLink`): as a Context card in a
 * one-to-one chat with the app, which the Messages extension opens here, and
 * as a link anywhere else, a group included. Unlike the other card pages,
 * this one is not a pure function of its address: it reads the chat's jobs
 * from the texting Worker through the `TEXTS` binding, with the token as the
 * only credential. A token the Worker does not hold, or one past its hours,
 * shows the same "this view has ended" page, so a guess learns nothing.
 *
 * Every word on it is Tex's own (a job's title, its status line, its steps:
 * tool and target, never a note's text) and set escaped. The page has no
 * script; while a job runs it reloads itself every ten seconds.
 */

import { escaped } from "./messagesPage";

export const THREADS_PATH = "/messages/threads";
const KEY = /^([0-9a-f]{64})\.([0-9a-f]{64})$/;
const REFRESH_SECONDS = 10;
const MAX_JOBS = 6;
const MAX_STEPS = 12;
const MAX_WORDS = 300;

type Step = { at: number; text: string };
type Job = { title: string; state: "running" | "done" | "failed" | "waiting" | "stuck"; startedAt: number; finishedAt?: number; status?: string; steps: Step[] };
type View = { now: number; max: number; jobs: Job[] };

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const words = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_WORDS) : "");
const instant = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** The Worker's answer, checked: anything malformed is dropped, never shown. */
export function readView(raw: unknown): View | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const now = instant(body.now);
  if (now === null || !Array.isArray(body.jobs)) return null;
  const jobs: Job[] = [];
  for (const item of body.jobs.slice(0, MAX_JOBS)) {
    if (!item || typeof item !== "object") continue;
    const job = item as Record<string, unknown>;
    const title = words(job.title);
    const startedAt = instant(job.startedAt);
    const state = job.state === "running" || job.state === "done" || job.state === "failed" || job.state === "waiting" || job.state === "stuck" ? job.state : null;
    if (!title || startedAt === null || state === null) continue;
    const finishedAt = instant(job.finishedAt);
    const status = words(job.status);
    const steps = (Array.isArray(job.steps) ? job.steps : [])
      .flatMap((step) => {
        const at = instant((step as Step | null)?.at);
        const text = words((step as Step | null)?.text);
        return at !== null && text ? [{ at, text }] : [];
      })
      .slice(-MAX_STEPS);
    jobs.push({ title, state, startedAt, ...(finishedAt !== null ? { finishedAt } : {}), ...(status ? { status } : {}), steps });
  }
  const max = typeof body.max === "number" && Number.isInteger(body.max) && body.max > 0 && body.max < 100 ? body.max : 3;
  return { now, max, jobs };
}

/** "just now", "4 min", "1 h 5 min". */
function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

const STATE_WORDS: Record<Job["state"], string> = { running: "Working", done: "Done", failed: "Stopped", waiting: "Waiting on you", stuck: "Stuck" };

function jobBlock(job: Job, now: number): string {
  const elapsed = job.state === "running" ? `${span(now - job.startedAt)} so far` : `${STATE_WORDS[job.state].toLowerCase()} ${span(now - (job.finishedAt ?? job.startedAt))} ago`;
  const steps = job.steps.length
    ? `<ol>${job.steps.map((step) => `<li><span class="when">${escaped(span(now - step.at))}</span>${escaped(step.text)}</li>`).join("")}</ol>`
    : `<p class="small">No steps yet.</p>`;
  return (
    `<details${job.state === "running" ? " open" : ""}><summary><span class="dot ${job.state}" aria-hidden="true"></span>` +
    `<span class="what"><b>${escaped(job.title)}</b><span class="detail">${escaped(STATE_WORDS[job.state])} · ${escaped(elapsed)}</span>` +
    `${job.status ? `<span class="detail">${escaped(job.status)}</span>` : ""}</span></summary>${steps}</details>`
  );
}

const STYLE = `:root{color-scheme:light dark;--fg:#000;--muted:#6e6e73;--line:#d1d1d6;--bg:#fff;--run:#007aff;--done:#248a3d;--fail:#c4314b}
@media (prefers-color-scheme:dark){:root{--fg:#fff;--muted:#a1a1a6;--line:#3a3a3c;--bg:#1c1c1e;--run:#0a84ff;--done:#30d158;--fail:#ff6961}}
body{margin:0;padding:16px 20px;background:var(--bg);color:var(--fg);font:16px/1.35 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;gap:10px}
h1{margin:0;font-size:17px;font-weight:600}p{margin:0;color:var(--muted);font-size:15px}.small{font-size:13px}
details{border:1px solid var(--line);border-radius:12px;padding:10px 14px}summary{display:flex;gap:10px;align-items:flex-start;cursor:pointer;list-style:none;min-height:44px}
summary::-webkit-details-marker{display:none}.what{display:flex;flex-direction:column;gap:2px;min-width:0}.detail{font-size:13px;color:var(--muted)}
.dot{width:10px;height:10px;border-radius:5px;margin-top:6px;flex-shrink:0}.dot.running{background:var(--run)}.dot.done{background:var(--done)}.dot.failed,.dot.stuck{background:var(--fail)}.dot.waiting{background:var(--run)}
ol{margin:8px 0 0;padding:0 0 0 20px;display:flex;flex-direction:column;gap:6px;font-size:14px}.when{display:inline-block;min-width:64px;color:var(--muted);font-size:12px}`;

function page(title: string, body: string, refresh: boolean): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : ""}` +
    `<title>${escaped(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": POLICY,
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const ENDED = "<h1>This view has ended</h1><p>Ask Tex what it's working on for a new one.</p>";

/** The page for `/messages/threads`, or null for any other path. */
export async function threadsResponse(request: Request, url: URL, env: { TEXTS?: Fetcher }): Promise<Response | null> {
  if (url.pathname !== THREADS_PATH) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const key = KEY.exec(url.searchParams.get("k") ?? "");
  if (key === null || env.TEXTS === undefined) return page("Tex", ENDED, false);
  let view: View | null = null;
  try {
    const answer = await env.TEXTS.fetch(`https://texts/threads/${key[1]}/${key[2]}`, { signal: AbortSignal.timeout(5_000) });
    view = answer.ok ? readView(await answer.json()) : null;
  } catch {
    view = null;
  }
  if (view === null) return page("Tex", ENDED, false);
  const running = view.jobs.filter((job) => job.state === "running").length;
  const heading = `<h1>What Tex is working on</h1><p class="small">${running} of ${view.max} running${running > 0 ? " · updates every few seconds" : ""}</p>`;
  const list = view.jobs.length ? view.jobs.map((job) => jobBlock(job, view!.now)).join("") : "<p>Nothing running right now.</p>";
  return page("What Tex is working on", heading + list, running > 0);
}
