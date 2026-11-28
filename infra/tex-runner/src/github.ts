/**
 * The three GitHub calls the Lab runner makes, on GH_RUNNER_TOKEN: register one just-in-time runner, read whether it
 * is online, and remove it. A just-in-time configuration registers one runner for one job; GitHub removes the runner
 * itself once that job ends, so `remove` is only for a runner that never took its job.
 */

export const REPO = "Supa-Media/context";
const API = "https://api.github.com";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubFailed";
  }
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "context-tex-runner",
});

/** The one label a run's job asks for, so no other job can take its runner: `tex-lab-<run>-<attempt>`. */
export function labelFor(runId: string, attempt: string): string {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new GitHubFailed("no run named");
  return `tex-lab-${runId}-${attempt}`;
}

export interface Registered {
  id: number;
  jitconfig: string;
}

export async function register(token: string, label: string, fetcher: Fetch = fetch): Promise<Registered> {
  const res = await fetcher(`${API}/repos/${REPO}/actions/runners/generate-jitconfig`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    // Group 1 is the repository's default group. `self-hosted` stays on every runner GitHub registers; the run's own
    // label is what the job asks for.
    body: JSON.stringify({ name: label, runner_group_id: 1, labels: [label], work_folder: "_work" }),
  });
  if (!res.ok) throw new GitHubFailed(`GitHub refused to register a runner (${res.status})`);
  const body = (await res.json().catch(() => null)) as { runner?: { id?: number }; encoded_jit_config?: string } | null;
  const id = Number(body?.runner?.id);
  if (!Number.isInteger(id) || !body?.encoded_jit_config) throw new GitHubFailed("GitHub's answer had no runner");
  return { id, jitconfig: body.encoded_jit_config };
}

/** "online", "offline", or "gone" once GitHub no longer has it. */
export async function status(token: string, id: number, fetcher: Fetch = fetch): Promise<"online" | "offline" | "gone"> {
  const res = await fetcher(`${API}/repos/${REPO}/actions/runners/${id}`, { headers: headers(token) });
  if (res.status === 404) return "gone";
  if (!res.ok) throw new GitHubFailed(`GitHub did not say how the runner is (${res.status})`);
  const body = (await res.json().catch(() => null)) as { status?: string } | null;
  return body?.status === "online" ? "online" : "offline";
}

export async function remove(token: string, id: number, fetcher: Fetch = fetch): Promise<void> {
  const res = await fetcher(`${API}/repos/${REPO}/actions/runners/${id}`, { method: "DELETE", headers: headers(token) });
  if (!res.ok && res.status !== 404) throw new GitHubFailed(`GitHub did not remove the runner (${res.status})`);
}
