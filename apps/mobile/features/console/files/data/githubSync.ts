/**
 * GitHub as a data source, the app's side (`apps/mcp/src/data/connect/githubApp.js`): an owner installs Context's
 * read-only GitHub App in a window of its own, and GitHub sends that window back to `/data/github/callback` with a
 * one-time code, the installation and the signed state the gateway made. That page hands them to the console tab
 * that opened it, on a same-origin channel, and the console tab, signed in as the owner, finishes it with the
 * gateway. The code is never stored: it lives in the two tabs' memory for the moment it takes.
 *
 * Board 02b is the form before the window, 02c the repository picker after it.
 */

import { postDataSync } from "./dataSync";

/** The channel the callback page and the console tab share. Same origin only, by the browser's own rule. */
export const GITHUB_CHANNEL = "context-github-install";
/** How long the console tab waits for the owner to finish on GitHub. */
const WAIT_MS = 15 * 60_000;

export const GITHUB_DATASETS = ["pull-requests", "deploys", "workflow-runs"] as const;

/** Each dataset's columns, as the gateway keeps them (`apps/mcp/src/data/connect/github.js`), drawn on board 02b. */
export const GITHUB_COLUMNS: Readonly<Record<(typeof GITHUB_DATASETS)[number], readonly string[]>> = {
  "pull-requests": ["repo", "number", "title", "author", "opened", "merged", "deployed", "lines_added", "lines_removed", "merge_commit"],
  deploys: ["repo", "sha", "environment", "started", "finished", "status"],
  "workflow-runs": ["repo", "workflow", "branch", "started", "finished", "conclusion", "sha"],
};

/** What GitHub sends back, as the callback page reads it from its address. */
export interface GithubReturn {
  readonly code: string;
  readonly installation: string;
  readonly state: string;
}

/** A callback address's fields, or why there are none: GitHub cancelled, or an organization owner must approve. */
export function githubReturnOf(params: Record<string, string | string[] | undefined>): GithubReturn | "request" | "cancelled" {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? "") : "";
  };
  if (one("setup_action") === "request") return "request";
  const code = one("code");
  const installation = one("installation_id");
  const state = one("state");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(code) || !/^[0-9]{1,15}$/.test(installation) || state === "" || state.length > 600) return "cancelled";
  return { code, installation, state };
}

export interface GithubRepo {
  readonly name: string;
  readonly private: boolean;
}

type Token = (refresh: false | { rejected: string }) => Promise<string>;

export interface GithubCalls {
  /** GitHub's install address for this source's about.md, or the sentence saying why not. */
  readonly start: (about: string) => Promise<{ url: string } | string>;
  /** The owner's return from GitHub, finished: null once connected and run, or why not. */
  readonly finish: (back: GithubReturn) => Promise<string | null>;
  /** The installation's repositories and the ones read (null: all), or why not. */
  readonly repos: () => Promise<{ repos: GithubRepo[]; picked: string[] | null } | string>;
  /** The owner's pick, run now: null, or why not. */
  readonly pick: (names: readonly string[]) => Promise<string | null>;
}

const said = (answer: { status: number; body: Record<string, unknown> | null } | null, fallback: string) =>
  answer !== null && typeof answer.body?.message === "string" && answer.body.message !== ""
    ? answer.body.message.slice(0, 500)
    : answer?.status === 403
      ? "Only this workspace's owners can connect GitHub."
      : answer?.status === 501
        ? "This deployment has no GitHub App set up."
        : fallback;

const reposOf = (body: Record<string, unknown> | null): GithubRepo[] =>
  (Array.isArray(body?.repos) ? body.repos : [])
    .map((repo) => (repo && typeof repo === "object" ? (repo as Record<string, unknown>) : {}))
    .filter((repo) => typeof repo.name === "string")
    .map((repo) => ({ name: String(repo.name), private: repo.private === true }));

/** The four GitHub calls on the gateway's `POST /@slug/files/data-sync`, with the console grant. */
export function githubCalls(options: { url: string; workspaceId: string; token: Token; fetchImpl?: typeof fetch }): GithubCalls {
  const post = (payload: Record<string, unknown>) =>
    postDataSync({ url: options.url, token: options.token, payload: { workspaceId: options.workspaceId, ...payload }, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const unreachable = "Context couldn't reach GitHub's connection just now. Try again.";
  return {
    start: async (about) => {
      const answer = await post({ op: "github_start", about });
      const url = answer?.status === 200 ? answer.body?.url : null;
      return typeof url === "string" && url.startsWith("https://github.com/") ? { url } : said(answer, unreachable);
    },
    finish: async (back) => {
      const answer = await post({ op: "github_finish", state: back.state, code: back.code, installation: back.installation });
      return answer?.status === 200 ? null : said(answer, unreachable);
    },
    repos: async () => {
      const answer = await post({ op: "github_repos" });
      if (answer?.status !== 200) return said(answer, unreachable);
      const picked = Array.isArray(answer.body?.picked) ? answer.body.picked.filter((name): name is string => typeof name === "string") : null;
      return { repos: reposOf(answer.body), picked };
    },
    pick: async (names) => {
      const answer = await post({ op: "github_repos", set: [...names] });
      return answer?.status === 200 ? null : said(answer, unreachable);
    },
  };
}

/**
 * Opens GitHub's install page in a window of its own and waits for the callback page to hand back what GitHub sent:
 * the return, `"closed"` when the window closed first, or `"blocked"` when the browser refused the window.
 */
export function openGithubInstall(url: string, deps: { open?: typeof window.open; channel?: (name: string) => BroadcastChannel } = {}): Promise<GithubReturn | "closed" | "blocked"> {
  const opener = deps.open ?? (typeof window === "undefined" ? undefined : window.open.bind(window));
  const makeChannel = deps.channel ?? ((name: string) => new BroadcastChannel(name));
  if (opener === undefined || (deps.channel === undefined && typeof BroadcastChannel === "undefined")) return Promise.resolve("blocked");
  const channel = makeChannel(GITHUB_CHANNEL);
  const popup = opener(url, "context-github", "popup,width=1020,height=760");
  if (popup === null) {
    channel.close();
    return Promise.resolve("blocked");
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: GithubReturn | "closed") => {
      if (done) return;
      done = true;
      clearInterval(watch);
      clearTimeout(deadline);
      channel.close();
      resolve(value);
    };
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (data?.kind !== "github-return" || typeof data.code !== "string" || typeof data.installation !== "string" || typeof data.state !== "string") return;
      channel.postMessage({ kind: "github-received" });
      finish({ code: data.code, installation: data.installation, state: data.state });
    };
    // A window closed without GitHub sending it back: give a just-sent message a moment, then stop waiting.
    const watch = setInterval(() => {
      if (popup.closed) setTimeout(() => finish("closed"), 1500);
    }, 1000);
    const deadline = setTimeout(() => finish("closed"), WAIT_MS);
  });
}

/**
 * The callback page's half: says what GitHub sent until the console tab answers, for up to a minute. Resolves true
 * once it answered, false when nothing did (the console tab was closed).
 */
export function handBackGithubReturn(back: GithubReturn, deps: { channel?: (name: string) => BroadcastChannel; waitMs?: number } = {}): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined" && deps.channel === undefined) return Promise.resolve(false);
  const channel = (deps.channel ?? ((name: string) => new BroadcastChannel(name)))(GITHUB_CHANNEL);
  return new Promise((resolve) => {
    let done = false;
    const end = (value: boolean) => {
      if (done) return;
      done = true;
      clearInterval(again);
      clearTimeout(deadline);
      channel.close();
      resolve(value);
    };
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as Record<string, unknown> | null)?.kind === "github-received") end(true);
    };
    const say = () => channel.postMessage({ kind: "github-return", ...back });
    say();
    const again = setInterval(say, 1000);
    const deadline = setTimeout(() => end(false), deps.waitMs ?? 60_000);
  });
}
