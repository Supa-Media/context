import { describe, expect, it } from "vitest";
import { settleCaptcha } from "./captcha";
import { solverLine, watchSolver, type SolverState } from "./captchaSolver";
import type { CdpTransport } from "./cdp";

/** A CDP connection that records what was sent and lets a test fire the browser's events. */
function fakeCdp() {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(params: unknown, sessionId?: string) => void>>();
  const cdp: CdpTransport = {
    async send(method) {
      sent.push(method);
      return {};
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close() {},
  };
  const fire = (method: string, params: unknown, sessionId?: string) => listeners.get(method)?.forEach((l) => l(params, sessionId));
  return { cdp, sent, fire };
}

describe("Browserbase's captcha solver", () => {
  it("knows only the solver's own three lines", () => {
    expect(solverLine("browserbase-solving-started")).toBe("solving");
    expect(solverLine(" browserbase-solving-finished ")).toBe("finished");
    expect(solverLine("browserbase-solving-errored")).toBe("errored");
    for (const other of ["browserbase-solving-started and more", "solving", "", null, 3, { text: "browserbase-solving-started" }]) expect(solverLine(other)).toBeNull();
  });

  it("hears the solver on the Log channel and on Runtime's, from a captcha's frame too, and turns on Log only", async () => {
    const { cdp, sent, fire } = fakeCdp();
    const solver = await watchSolver(cdp, (method) => cdp.send(method));
    // Runtime.enable is a known bot-check tell: never sent.
    expect(sent).toEqual(["Log.enable"]);
    expect(solver.state()).toBeNull();
    fire("Log.entryAdded", { entry: { text: "browserbase-solving-started" } }, "page-1");
    expect(solver.state()).toBe("solving");
    fire("Runtime.consoleAPICalled", { args: [{ value: "browserbase-solving-errored" }] }, "captcha-frame");
    expect(solver.state()).toBe("errored");
    fire("Runtime.consoleAPICalled", { args: [{ value: "browserbase-solving-finished" }] }, "page-1");
    expect(solver.state()).toBe("finished");
    fire("Runtime.consoleAPICalled", { args: [{ value: "the page's own words" }] }, "page-1");
    expect(solver.state()).toBe("finished");
  });

  it("after the steps, waits for a solve nothing on the page shows, and an errored one is not solved", async () => {
    let t = 0;
    const blank = async () => ({ widget: false, answered: false, wall: false, invisible: true });
    let state: SolverState | null = "solving";
    const clock = { now: () => t, wait: async (ms: number) => void ((t += ms) >= 3_000 && (state = "finished")) };
    expect(await settleCaptcha(blank, { ...clock, solver: { state: () => state } })).toBe("solved");
    t = 0;
    state = "solving";
    const failing = { now: () => t, wait: async (ms: number) => void ((t += ms) >= 3_000 && (state = "errored")) };
    expect(await settleCaptcha(blank, { ...failing, solver: { state: () => state } })).toBe("unsolved");
    expect(await settleCaptcha(blank, { solver: { state: () => null } })).toBeNull();
  });
});
