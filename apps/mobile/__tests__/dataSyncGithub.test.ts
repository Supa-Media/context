/**
 * @jest-environment jsdom
 */

/**
 * GitHub in the app (`features/console/files/data/`): board 02's GitHub tile, 02b's form, 02c's repository picker,
 * the window GitHub sends the owner back to, and the calls that finish it with the gateway.
 *
 * The properties with teeth: GitHub's answer crosses from the callback window only to a tab that is waiting for it,
 * and only GitHub's own fields; nothing about GitHub is written into a file but what the source is; the GitHub tile
 * is drawn only when the owner's GitHub calls are there.
 *
 * SABOTAGE (confirmed, reverted): accept a callback without `installation_id` in `githubReturnOf` → "reads GitHub's
 * answer" fails; let `openGithubInstall` resolve on any message → "waits for GitHub's answer" fails; draw the GitHub
 * tile without `github` → "only an owner on the web sees GitHub" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { setImmediate as realSetImmediate } from "timers";
import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
}));

const mockData: { current: unknown } = { current: null };
jest.mock("../features/console/ConsoleDataContext", () => ({
  ...jest.requireActual<Record<string, unknown>>("../features/console/ConsoleDataContext"),
  useOptionalConsoleData: () => mockData.current,
}));
const mockMint = async () => ({ accessToken: "fake-token" });
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => mockMint }));

import { ThemeProvider } from "../features/design/theme";
import { ConnectSourceDialog } from "../features/console/files/data/ConnectSource";
import { GithubForm, GithubRepos, type GithubFlow } from "../features/console/files/data/GithubConnect";
import { nextStatusRetry, STATUS_RETRY_MS, useSourceSyncs, type SourceSyncs } from "../features/console/files/data/useSourceSync";
import type { DataSource } from "../features/console/files/data/sources";
import { githubSourceFiles } from "../features/console/files/data/dataWrites";
import { githubCalls, githubReturnOf, handBackGithubReturn, openGithubInstall, GITHUB_CHANNEL } from "../features/console/files/data/githubSync";
import { settingsOf } from "../features/console/files/data/words";
import { sourceAt } from "../features/console/files/data/sources";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

let roots: { root: Root; node: HTMLElement }[] = [];
function unmountAll() {
  for (const { root, node } of roots) {
    act(() => root.unmount());
    node.remove();
  }
  roots = [];
}
afterEach(() => {
  unmountAll();
  jest.useRealTimers();
});
const deferred = () => {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

async function mount(element: ReactElement): Promise<HTMLElement> {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  roots.push({ root, node });
  await act(async () => {
    root.render(h(ThemeProvider, { scheme: "light", children: element }));
  });
  return node;
}
const find = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const element = find(id);
  if (element === null) throw new Error(`no ${id}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
const json = (body: unknown, status = 200) => ({ status, json: async () => JSON.parse(JSON.stringify(body)) as unknown }) as unknown as Response;

/** Two ends of one same-origin channel, as BroadcastChannel gives a callback window and the console tab. */
function channelPair() {
  const ends: { onmessage: ((event: MessageEvent) => void) | null; sent: unknown[]; postMessage: (data: unknown) => void; close: () => void }[] = [];
  const make = () => {
    const end = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      sent: [] as unknown[],
      postMessage(data: unknown) {
        end.sent.push(data);
        for (const other of ends) if (other !== end) other.onmessage?.({ data } as MessageEvent);
      },
      close() {},
    };
    ends.push(end);
    return end as unknown as BroadcastChannel;
  };
  return { make, ends };
}

const BACK = { code: "oneTimeCode123", installation: "77", state: "abc.def" };

describe("the window GitHub sends the owner back to", () => {
  test("reads GitHub's answer: the code, the installation and the state, or why there is none", () => {
    expect(githubReturnOf({ code: BACK.code, installation_id: "77", setup_action: "install", state: BACK.state })).toEqual(BACK);
    expect(githubReturnOf({ code: BACK.code, state: BACK.state })).toBe("cancelled");
    expect(githubReturnOf({ installation_id: "77", state: BACK.state })).toBe("cancelled");
    expect(githubReturnOf({ setup_action: "request", state: BACK.state })).toBe("request");
    expect(githubReturnOf({ code: "x y", installation_id: "77", state: BACK.state })).toBe("cancelled");
  });

  test("waits for GitHub's answer, hands it back once, and ignores anything else on the channel", async () => {
    const { make } = channelPair();
    const popup = { closed: false };
    const opened: string[] = [];
    const waiting = openGithubInstall("https://github.com/apps/context-data/installations/new?state=abc", {
      open: ((url: string) => {
        opened.push(url);
        return popup;
      }) as unknown as typeof window.open,
      channel: () => make(),
    });
    const callback = make();
    callback.postMessage({ kind: "github-return", code: 5 });
    callback.postMessage({ kind: "something-else", ...BACK });
    const handed = handBackGithubReturn(BACK, { channel: () => callback, waitMs: 2000 });
    await expect(waiting).resolves.toEqual(BACK);
    await expect(handed).resolves.toBe(true);
    expect(opened).toEqual(["https://github.com/apps/context-data/installations/new?state=abc"]);
    expect(GITHUB_CHANNEL).toBe("context-github-install");
  });

  test("a refused window says so, and a callback nobody waits for says the tab is gone", async () => {
    await expect(openGithubInstall("https://github.com/x", { open: (() => null) as unknown as typeof window.open, channel: () => channelPair().make() })).resolves.toBe("blocked");
    await expect(handBackGithubReturn(BACK, { channel: () => channelPair().make(), waitMs: 50 })).resolves.toBe(false);
  });
});

describe("GitHub's files and calls", () => {
  test("its folder holds an about.md that names only the source, beside three empty sheets", () => {
    const made = githubSourceFiles("data", null, new Set(["data/github/about.md"]));
    expect(made.folder).toBe("data/github-2");
    expect(made.files.map((file) => file.path)).toEqual(["data/github-2/about.md", "data/github-2/pull-requests.csv", "data/github-2/deploys.csv", "data/github-2/workflow-runs.csv"]);
    expect(made.files[0]?.text).toMatch(/^---\nsource: github\nname: "GitHub"\n---/);
    expect(made.files[0]?.text).not.toMatch(/token|installation:/i);
  });

  test("start, finish and repositories each send only their own fields", async () => {
    const sent: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      if (body.op === "github_start") return json({ url: "https://github.com/apps/context-data/installations/new?state=s" });
      if (body.op === "github_finish") return json({ app: "github", armed: true });
      return json({ repos: [{ name: "supa/app", private: true }], picked: null });
    }) as unknown as typeof fetch;
    const calls = githubCalls({ url: "https://mcp.example.test/@acme/files/data-sync", workspaceId: "w1", token: async () => "t", fetchImpl });
    expect(await calls.start("data/github/about.md")).toEqual({ url: "https://github.com/apps/context-data/installations/new?state=s" });
    expect(await calls.finish(BACK)).toBeNull();
    expect(await calls.repos()).toEqual({ repos: [{ name: "supa/app", private: true }], picked: null });
    expect(await calls.pick(["supa/app"])).toBeNull();
    expect(sent).toEqual([
      { workspaceId: "w1", op: "github_start", about: "data/github/about.md" },
      { workspaceId: "w1", op: "github_finish", state: BACK.state, code: BACK.code, installation: BACK.installation },
      { workspaceId: "w1", op: "github_repos" },
      { workspaceId: "w1", op: "github_repos", set: ["supa/app"] },
    ]);
    const elsewhere = githubCalls({ url: "https://x.test/@a/files/data-sync", workspaceId: "w1", token: async () => "t", fetchImpl: (async () => json({ url: "https://evil.example/install" })) as unknown as typeof fetch });
    expect(typeof (await elsewhere.start("data/github/about.md"))).toBe("string");
  });
});

describe("boards 02, 02b and 02c", () => {
  const flow = (picked: string[][] = []): GithubFlow => ({
    begin: async () => null,
    repos: async () => ({ repos: [{ name: "supa/app", private: true }, { name: "supa/context", private: false }, { name: "supa/site", private: false }], picked: ["supa/app", "supa/context"] }),
    pick: async (names) => {
      picked.push([...names]);
      return null;
    },
  });
  const dialog = (extra: Record<string, unknown>) =>
    h(ConnectSourceDialog, { dataFolder: "data", taken: new Set<string>(), sheet: false, onMake: async () => null, onMakeUrl: async () => null, onConnectApp: async () => null, sources: [], onClose: () => {}, ...extra });

  test("only an owner on the web sees GitHub; its form shows the three datasets, then the picker starts syncing the pick", async () => {
    await mount(dialog({}));
    expect(find("connect-app-github")).toBeNull();
    unmountAll();
    const picked: string[][] = [];
    await mount(dialog({ github: flow(picked) }));
    await press("connect-app-github");
    for (const dataset of ["pull-requests", "deploys", "workflow-runs"]) expect(find(`github-set-${dataset}`)).not.toBeNull();
    expect(document.body.textContent).toContain("Can't change code, settings or secrets");
    await press("connect-github-make");
    // Just connected: the first sync is still to come, so the picker says so.
    expect(document.body.textContent).toContain("Syncing for the first time… then every hour");
    expect(find("github-repos")?.textContent).toContain("supa/site");
    expect(find("github-repo-supa/app")?.getAttribute("aria-checked")).toBe("true");
    expect(find("github-repo-supa/site")?.getAttribute("aria-checked")).toBe("false");
    await press("github-repo-supa/context");
    await press("github-repos-start");
    expect(picked).toEqual([["supa/app"]]);
  });

  test("GitHub's settings say no token is kept", () => {
    const about: ListNote = { path: "data/github/about.md", properties: { source: "github", name: "GitHub" } };
    const listing = { path: "data/github", folderDefault: "team", truncated: false, manifestUsable: true, entries: [{ kind: "file", path: "data/github/about.md", name: "about.md", visibility: "team", inherited: "team", exception: false, readOnly: false } as FileEntry] } as unknown as FolderListing;
    const source = sourceAt("data/github", () => listing, [about]);
    const lines = settingsOf(source).map((setting) => `${setting.key}: ${setting.values.join(", ")}`);
    expect(lines).toContain("sign-in: Read-only GitHub App, installed by an owner; no token is kept");
  });
});

describe("the picker and the form while GitHub finishes", () => {
  type Answer = { repos: { name: string; private: boolean }[]; picked: null } | string;
  const picker = (repos: jest.Mock<() => Promise<Answer>>) =>
    h(GithubRepos, {
      flow: { begin: async () => null, repos: repos as unknown as GithubFlow["repos"], pick: async () => null } as GithubFlow,
      onClose: () => {},
    });

  test("the repository picker asks GitHub once per open, however often it redraws, and again only on Try again", async () => {
    let answer: Answer = { repos: [{ name: "supa/app", private: true }], picked: null };
    const repos = jest.fn(async () => answer);
    await mount(picker(repos));
    const root = roots[roots.length - 1]!.root;
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        root.render(h(ThemeProvider, { scheme: "light", children: picker(repos) }));
      });
    }
    expect(repos).toHaveBeenCalledTimes(1);
    expect(find("github-repo-supa/app")).not.toBeNull();

    // A listing that failed says so and offers Try again, which asks once more.
    unmountAll();
    answer = "GitHub didn't answer. Try again.";
    await mount(picker(repos));
    expect(repos).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("GitHub didn't answer. Try again.");
    answer = { repos: [{ name: "supa/site", private: false }], picked: null };
    await press("github-repos-retry");
    expect(repos).toHaveBeenCalledTimes(3);
    expect(find("github-repo-supa/site")).not.toBeNull();
  });

  test("the form says Connecting… once GitHub sent the owner back", async () => {
    const reached = deferred();
    const back = deferred();
    let connected = 0;
    const flow: GithubFlow = {
      begin: async (onStep) => {
        await reached.wait;
        onStep?.("connecting");
        await back.wait;
        return null;
      },
      repos: async () => ({ repos: [], picked: null }),
      pick: async () => null,
    };
    await mount(h(GithubForm, { flow, onConnected: () => (connected += 1), onClose: () => {} }));
    await press("connect-github-make");
    expect(document.body.textContent).toContain("Waiting for GitHub…");
    expect(document.body.textContent).not.toContain("Connecting…");

    await act(async () => {
      reached.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Connecting…");
    expect(document.body.textContent).not.toContain("Waiting for GitHub…");
    expect(document.body.textContent).toContain("GitHub sent you back. Context is connecting it.");

    await act(async () => {
      back.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(connected).toBe(1);
  });
});

describe("a status ask that failed or found a first run still going", () => {
  test("the retry decision: a failed ask or a first run still going is asked again, on the fixed schedule", () => {
    const failed = { ok: false as const, said: "Context couldn't reach the sync just now. Try again." };
    const running = { ok: true as const, sources: [{ about: "data/feed/about.md", armed: true, last: null }] };
    const landed = { ok: true as const, sources: [{ about: "data/feed/about.md", armed: true, last: { at: 1, outcome: "ok" as const } }] };
    expect(STATUS_RETRY_MS).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
    expect(nextStatusRetry(failed, 0)).toBe(5_000);
    expect(nextStatusRetry(running, 1)).toBe(15_000);
    expect(nextStatusRetry(landed, 0)).toBeNull();
    expect(nextStatusRetry({ ok: true, sources: [] }, 0)).toBeNull();
    expect(nextStatusRetry(failed, STATUS_RETRY_MS.length - 1)).toBe(120_000);
    expect(nextStatusRetry(failed, STATUS_RETRY_MS.length)).toBeNull();
  });

  test("the sync list asks again after a failure, stops once the first run landed, and never polls forever", async () => {
    // React's scheduler runs on the timers it has, so only the page's own timers are faked.
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask", "requestAnimationFrame"] });
    const about = "data/feed/about.md";
    const replies = [
      { status: 500, body: { message: "Try again later." } },
      { status: 200, body: { sources: [{ about, armed: true, last: null }] } },
      { status: 200, body: { sources: [{ about, armed: true, last: { at: 1, outcome: "ok", rows: 3 } }] } },
    ];
    const fetchMock = jest.fn(async () => {
      const next = replies.shift() ?? { status: 200, body: { sources: [{ about, armed: true, last: { at: 1, outcome: "ok", rows: 3 } }] } };
      return json(next.body, next.status);
    });
    const real = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      mockData.current = {
        demo: false,
        selectedContextId: "c1",
        contexts: [{ id: "c1", slug: "acme", role: "owner", name: "Acme" }],
      };
      const source = { kind: "fetch", about: { path: about, properties: {} }, aboutPath: about, folder: "data/feed", datasets: [] } as unknown as DataSource;
      const seen: SourceSyncs[] = [];
      const Probe = () => {
        seen.push(useSourceSyncs([source]));
        return null;
      };
      await mount(h(Probe));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Timers and the fetch replies run in order. `act` waits on timers itself, so between steps the state changes are
      // let through by a real macrotask from Node's timers module, which fake timers leave alone.
      const macrotask = () => new Promise<void>((resolve) => realSetImmediate(resolve));
      // The page's timer updates the state outside `act`, as it does in the app; the warning is off for these steps only.
      const env = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
      env.IS_REACT_ACT_ENVIRONMENT = false;
      // React's scheduler also waits on a timer here, so each step runs the timers that fall due after it too.
      const tick = async (ms: number) => {
        for (let i = 0; i < 4; i++) {
          await jest.advanceTimersByTimeAsync(i === 0 ? ms : 0);
          await macrotask();
        }
      };
      await tick(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await tick(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await tick(15_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(seen[seen.length - 1]?.syncOf("data/feed")).toEqual({ known: true, syncedAt: 1, rows: 3 });
      // The first run landed: nothing more is asked, however long the page stays open.
      await tick(10 * 60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.fetch = real;
      mockData.current = null;
      (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
});

