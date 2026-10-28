/**
 * @jest-environment jsdom
 */

/**
 * The line under Notes stops flickering (Dev2, 2026-10-18: "keeps flickering
 * … between spinning [and] how many notes are actually downloaded").
 *
 * SABOTAGE: return `row` unchanged from `useSteadyDownloadRow` and the first
 * test fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DownloadRow } from "../features/offline/downloadSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { STEADY_DOWNLOAD_MS, useSteadyDownloadRow } =
  require("../features/console/files/Downloads") as typeof import("../features/console/files/Downloads");

const row = (state: DownloadRow["state"], done: number, total: number): DownloadRow => ({
  workspaceId: "w1",
  label: "@seyi",
  state,
  done,
  total,
});

afterEach(() => {
  jest.useRealTimers();
});

function harness(first: DownloadRow) {
  let seen: DownloadRow | undefined;
  const Probe = ({ value }: { value: DownloadRow }) => {
    seen = useSteadyDownloadRow(value);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe, { value: first })));
  return {
    seen: () => seen,
    set: (value: DownloadRow) => act(() => root.render(createElement(Probe, { value }))),
  };
}

describe("the downloaded line", () => {
  test("a pass that finds two notes says no download, only what is on the phone", () => {
    jest.useFakeTimers();
    const ui = harness(row("done", 2844, 2844));
    ui.set(row("downloading", 2842, 2844));
    expect(ui.seen()).toMatchObject({ state: "done", done: 2842, total: 2842 });
    ui.set(row("done", 2844, 2844));
    expect(ui.seen()).toMatchObject({ state: "done", total: 2844 });
  });

  test("a download that lasts says so, with the spinner's state", () => {
    jest.useFakeTimers();
    const ui = harness(row("downloading", 10, 2844));
    act(() => {
      jest.advanceTimersByTime(STEADY_DOWNLOAD_MS);
    });
    expect(ui.seen()).toMatchObject({ state: "downloading", done: 10, total: 2844 });
    // Counts move on at once while it lasts.
    ui.set(row("downloading", 400, 2844));
    expect(ui.seen()).toMatchObject({ state: "downloading", done: 400 });
  });
});
