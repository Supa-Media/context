/**
 * @jest-environment jsdom
 */

/**
 * Signing Claude Code in on a computer from the Tex page (`TexMachineSignIn.tsx`,
 * the gateway's `/machines/app/sign-in`): the list answer's sign-in read into
 * the page, the page's actions as route calls, only the maker's own link
 * opened, and the steps on the glass from Sign in to signed in.
 *
 * ## Sabotage record (2026-11-05, temporary local edits, reverted)
 *
 *   `signInLinkOk` accepting any https host                        1 failing
 *   the Sign in button drawn for a runner that can't sign in        1 failing
 *   the code sent untrimmed                                         1 failing
 *   (2026-11-05, install and Codex's device sign-in)
 *   the Install button drawn for a runner that can't install         1 failing
 *   Codex's code panel offering a paste box                          1 failing
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { SIGN_IN_FRESH_MS, signInFor, signInLinkOk } from "../features/tex/page/TexMachineSignIn";
import { INSTALL_FRESH_MS, installFor, installLine } from "../features/tex/page/TexMachineInstall";
import { machineCallOf, machinesPageOf } from "../features/tex/page/texMachineGateway";
import { folderExample, folderProblem } from "../features/tex/page/texMachineFormat";
import { machineFixtureSource } from "../features/tex/page/texMachineFixture";
import { fixtureNow } from "../features/tex/page/texPageFixture";
import type { TexPageSource } from "../features/tex/page/texPageSource";
import type { PageAction } from "../features/tex/page/texPageTypes";
import { useTexPage } from "../features/tex/page/useTexPage";

const NOW = 1_800_000_000_000;
const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=x";

const listed = (extra: Record<string, unknown> = {}) => ({
  id: "m1",
  name: "Ada's MacBook Pro",
  os: "macos",
  ownerId: "user_1",
  runs: true,
  online: true,
  tools: ["claude"],
  limits: { slots: 2, dayMs: 3_600_000 },
  facts: { signIn: ["claude"] },
  status: { ready: false, notReady: "signed_out", tools: [{ name: "claude", installed: true, signedIn: false }] },
  ...extra,
});

describe("a sign-in, read and sent", () => {
  test("the list answer's sign-in and what the runner can sign in reach the page", () => {
    const m = machinesPageOf({ ok: true, machines: [listed({ signIn: { id: "si_1", tool: "claude", state: "link", url: LINK, at: NOW } })] }, { now: NOW })?.machines[0];
    expect(m?.state).toBe("notReady");
    expect(m?.tools.claude).toBe("installed");
    expect(m?.canSignIn).toEqual(["claude"]);
    expect(m?.signIn).toEqual({ id: "si_1", tool: "claude", state: "link", url: LINK, at: NOW });
  });

  test("an older runner can't sign in from the page, and a link that isn't https is dropped", () => {
    const m = machinesPageOf({ ok: true, machines: [listed({ facts: {}, signIn: { id: "si_1", tool: "claude", state: "link", url: "http://claude.com/x", at: NOW } })] }, { now: NOW })?.machines[0];
    expect(m?.canSignIn).toEqual([]);
    expect(m?.signIn?.url).toBeUndefined();
  });

  test("starting and finishing go to the sign-in route, the code trimmed", () => {
    expect(machineCallOf({ type: "machine.signIn", id: "m1", tool: "claude" }, () => null)).toEqual({ route: "sign-in", body: { machineId: "m1", tool: "claude" } });
    expect(machineCallOf({ type: "machine.signInCode", id: "m1", signInId: "si_1", code: "  abc#def \n" }, () => null)).toEqual({ route: "sign-in", body: { machineId: "m1", signInId: "si_1", code: "abc#def" } });
  });

  test("only the tool maker's own page is opened", () => {
    expect(signInLinkOk(LINK)).toBe(true);
    expect(signInLinkOk("https://platform.claude.com/oauth")).toBe(true);
    expect(signInLinkOk("https://auth.openai.com/codex/device")).toBe(true);
    expect(signInLinkOk("https://auth.openai.com.evil.example/codex/device")).toBe(false);
    expect(signInLinkOk("https://claude.com.evil.example/x")).toBe(false);
    expect(signInLinkOk("https://evil.example/claude.com")).toBe(false);
    expect(signInLinkOk("http://claude.com/x")).toBe(false);
    expect(signInLinkOk(undefined)).toBe(false);
  });

  test("an install is read into the page, and sent as the tool alone", () => {
    const m = machinesPageOf(
      { ok: true, machines: [listed({ facts: { signIn: ["claude", "codex"], install: ["claude", "codex"] }, install: { id: "in_1", tool: "codex", state: "working", step: "downloading", percent: 62, at: NOW } })] },
      { now: NOW },
    )?.machines[0];
    expect(m?.canInstall).toEqual(["claude", "codex"]);
    expect(m?.install).toEqual({ id: "in_1", tool: "codex", state: "working", step: "downloading", percent: 62, at: NOW });
    expect(machineCallOf({ type: "machine.install", id: "m1", tool: "codex" }, () => null)).toEqual({ route: "install", body: { machineId: "m1", tool: "codex" } });
    const install = { id: "in_1", tool: "codex" as const, state: "working" as const, step: "downloading" as const, percent: 62, at: NOW };
    expect(installLine(install, "Ada's MacBook Pro")).toBe("Downloading on Ada's MacBook Pro… 62%");
    expect(installFor({ install }, "codex", NOW + INSTALL_FRESH_MS + 1)).toBeNull();
    expect(installFor({ install }, "claude", NOW)).toBeNull();
  });

  test("a sign-in older than the computer waits is not drawn", () => {
    const signIn = { id: "si_1", tool: "claude" as const, state: "link" as const, at: NOW };
    expect(signInFor({ signIn }, "claude", NOW + 60_000)).toBe(signIn);
    expect(signInFor({ signIn }, "claude", NOW + SIGN_IN_FRESH_MS + 1)).toBeNull();
    expect(signInFor({ signIn }, "codex", NOW)).toBeNull();
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Harness({ source, start }: { source: TexPageSource; start: Place }) {
  const [place, setPlace] = useState<Place>(start);
  const page = useTexPage(source, place.chat);
  return createElement(TexPageBody, { source, page, place, go: setPlace, computer: null, openComputer: () => {}, now: fixtureNow });
}

const tick = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const el = byTestId(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
  await tick();
}

describe("on the computer's page", () => {
  test("Sign in shows the link, and the pasted code signs Claude Code in", async () => {
    const source = machineFixtureSource("notReady");
    const sent: PageAction[] = [];
    const watched: TexPageSource = { ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: watched, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    expect(byTestId("tex-machine-tool-claude-link")).toBeNull();
    await press("tex-machine-tool-claude-signin");
    expect(sent).toEqual([{ type: "machine.signIn", id: "m-mbp", tool: "claude" }]);
    expect(byTestId("tex-machine-signin")).not.toBeNull();
    expect(byTestId("tex-machine-signin-open")?.textContent).toContain("Open Claude Code sign-in");
    const input = byTestId("tex-machine-signin-code") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, " good#state ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("tex-machine-signin-send");
    expect(sent[1]).toEqual({ type: "machine.signInCode", id: "m-mbp", signInId: "si_fixture", code: "good#state" });
    await tick();
    expect(byTestId("tex-machine-signin-done")?.textContent).toContain("Claude Code is signed in on");
  });

  test("a runner that can't sign in from the page keeps the how-to link", async () => {
    const source = machineFixtureSource("notReady");
    const plain: TexPageSource = {
      ...source,
      machines: async (chat) => {
        const read = await source.machines(chat);
        if (read.kind === "ok") for (const m of read.value.machines) m.canSignIn = [];
        return read;
      },
    };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: plain, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    expect(byTestId("tex-machine-tool-claude-signin")).toBeNull();
    expect(byTestId("tex-machine-tool-claude-link")?.textContent).toContain("How to sign in");
  });

  test("a missing tool installs from its row, then offers Sign in", async () => {
    const source = machineFixtureSource("notReady");
    const sent: PageAction[] = [];
    const watched: TexPageSource = { ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: watched, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    expect(byTestId("tex-machine-tool-codex-link")).toBeNull();
    await press("tex-machine-tool-codex-install");
    expect(sent).toEqual([{ type: "machine.install", id: "m-mbp", tool: "codex" }]);
    await tick();
    expect(byTestId("tex-machine-tool-codex-install")).toBeNull();
    expect(byTestId("tex-machine-tool-codex-signin")).not.toBeNull();
  });

  test("a runner that can't install keeps the how-to link", async () => {
    const source = machineFixtureSource("notReady");
    const plain: TexPageSource = {
      ...source,
      machines: async (chat) => {
        const read = await source.machines(chat);
        if (read.kind === "ok") for (const m of read.value.machines) m.canInstall = [];
        return read;
      },
    };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: plain, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    expect(byTestId("tex-machine-tool-codex-install")).toBeNull();
    expect(byTestId("tex-machine-tool-codex-link")?.textContent).toContain("How to add it");
  });

  test("Codex shows its one-time code to type on OpenAI's page, with nothing to paste", async () => {
    const source = machineFixtureSource("notReady");
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    await press("tex-machine-tool-codex-install");
    await press("tex-machine-tool-codex-signin");
    expect(byTestId("tex-machine-signin-device")).not.toBeNull();
    expect(byTestId("tex-machine-signin-usercode")?.textContent).toBe("7K2Q-M9XFD");
    expect(byTestId("tex-machine-signin-open")?.textContent).toContain("Open Codex sign-in");
    expect(byTestId("tex-machine-signin-code")).toBeNull();
  });
});

describe("renaming a computer", () => {
  test("the name goes as one patch, trimmed, and an empty or over-long one is refused", () => {
    const one = (id: string) => (id === "m1" ? (listed({}) as Record<string, unknown>) : null);
    expect(machineCallOf({ type: "machine.set", id: "m1", values: { name: "  kazoo box " } }, one)).toEqual({ route: "set", body: { machineId: "m1", patch: { name: "kazoo box" } } });
    expect(machineCallOf({ type: "machine.set", id: "m1", values: { name: "   " } }, one)).toEqual({ refused: "bad_name" });
    expect(machineCallOf({ type: "machine.set", id: "m1", values: { name: "x".repeat(101) } }, one)).toEqual({ refused: "bad_name" });
  });

  test("Rename on the computer's page saves the new name and shows it", async () => {
    const source = machineFixtureSource("notReady");
    const sent: PageAction[] = [];
    const watched: TexPageSource = { ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: watched, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    await press("tex-machine-rename");
    const input = byTestId("tex-machine-name-input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, " Studio box ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("tex-machine-name-save");
    expect(sent).toEqual([{ type: "machine.set", id: "m-mbp", values: { name: "Studio box" } }]);
    await tick();
    expect(byTestId("tex-machine-name-input")).toBeNull();
    expect(byTestId("tex-machine")?.textContent).toContain("Studio box");
  });
});

describe("choosing folders", () => {
  test("a path the computer would drop is named, never saved quietly", () => {
    expect(folderProblem("/home/dev2/code")).toBeNull();
    expect(folderProblem("/Users/ada/code/context")).toBeNull();
    expect(folderProblem("~/code")).toContain("full path");
    expect(folderProblem("code")).toContain("full path");
    expect(folderProblem("/home/dev2")).toContain("not all of it");
    expect(folderProblem("/home/dev2/../x")).toContain("..");
    expect(folderExample("mac")).toBe("/Users/you/code");
    expect(folderExample("cli")).toBe("/home/you/code");
  });

  test("Save with ~/code says why and keeps the box open; a full path saves", async () => {
    const source = machineFixtureSource("notReady");
    const sent: PageAction[] = [];
    const watched: TexPageSource = { ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) };
    act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source: watched, start: { chat: "me", view: "machine", machine: "m-mbp" } }))));
    await tick();
    await press("tex-machine-folders-edit");
    const input = byTestId("tex-machine-folders-input") as HTMLTextAreaElement;
    expect(input.getAttribute("placeholder")).not.toContain("~");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const type = (text: string) =>
      act(() => {
        setValue.call(byTestId("tex-machine-folders-input"), text);
        byTestId("tex-machine-folders-input")!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("~/code");
    await press("tex-machine-folders-save");
    expect(sent).toEqual([]);
    expect(byTestId("tex-machine-folders-error")?.textContent).toContain("full path");
    expect(byTestId("tex-machine-folders-input")).not.toBeNull();
    type("/Users/ada/code");
    await press("tex-machine-folders-save");
    expect(sent).toEqual([{ type: "machine.set", id: "m-mbp", values: { folders: ["/Users/ada/code"] } }]);
    expect(byTestId("tex-machine-folders-error")).toBeNull();
  });
});
