import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INSTALL_AND_PAIR_COMMAND,
  INSTALL_COMMAND,
  INSTALL_SECTIONS,
  LINGER_COMMAND,
  PAIR_COMMAND,
  RUNNER_BIN,
  SERVICE_COMMAND,
  STATUS_COMMAND,
  agentInstructions,
} from "../features/install/installGuide";
import { setupPrompt } from "../../mcp/src/machines/setupPrompt.js";

/**
 * `context.lc/download` (Dev2, 2026-11-05): how to install Context on a Mac,
 * Linux and a headless server, and instructions to hand a coding agent. Every
 * command and download on it is held here to the files that make it true, so
 * the page cannot tell people to run something that does not exist — which
 * is what the Connect screen did with `npx @supa-media/context machine`, a
 * command the published package never had.
 */
const ROOT = join(__dirname, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const README = read("apps/machine-runner/README.md");
const INSTALLER = read("apps/machine-runner/install.sh");
const SERVICE = read("apps/machine-runner/src/service.rs");
const PAIR = read("apps/machine-runner/src/pair.rs");
const ROUTER = read("infra/router/src/download.ts");
const CONNECT = read("apps/mobile/features/tex/page/TexConnectPage.tsx");

const everyCommand = INSTALL_SECTIONS.flatMap((s) => s.steps.flatMap((step) => step.commands ?? []));
const everyLink = INSTALL_SECTIONS.flatMap((s) => [...s.steps.flatMap((step) => step.links ?? []), ...(s.asideLinks ?? [])]);

describe("the install page's commands are the runner's own", () => {
  test("the installer is the one install.sh documents for itself", () => {
    expect(INSTALLER).toContain(`#   ${INSTALL_COMMAND}`);
    expect(README).toContain(INSTALL_COMMAND);
  });

  test("pair, service install and status are commands the README lists", () => {
    for (const command of [PAIR_COMMAND, SERVICE_COMMAND, STATUS_COMMAND]) expect(README).toContain(command);
  });

  test("linger is what the service itself tells you to run, and the binary lands where the page says", () => {
    expect(SERVICE).toContain(LINGER_COMMAND);
    expect(INSTALLER).toContain('INSTALL_DIR="${CONTEXT_MACHINE_DIR:-$HOME/.context-machine}"');
    expect(INSTALLER).toContain('BIN_DIR="$INSTALL_DIR/bin"');
    expect(RUNNER_BIN).toBe("$HOME/.context-machine/bin");
  });

  test("pairing prints a link and a code and waits 30 minutes, as the page says", () => {
    expect(PAIR).toContain('println!("Approve this machine at {}", start.approve_url)');
    expect(PAIR).toContain("Duration::from_secs(30 * 60)");
  });

  test("every shell line on the page is one of those, and no step asks for sudo or npx", () => {
    const known = new Set([INSTALL_COMMAND, PAIR_COMMAND, SERVICE_COMMAND, LINGER_COMMAND, STATUS_COMMAND]);
    expect(everyCommand.length).toBeGreaterThan(0);
    for (const line of everyCommand) expect(known.has(line)).toBe(true);
    expect(everyCommand.join("\n")).not.toMatch(/sudo|npx/);
  });

  test("the headless tab keeps the runner alive after logout; the Linux desktop tab needs no linger", () => {
    const tab = (t: string) => INSTALL_SECTIONS.find((s) => s.tab === t)!.steps.flatMap((s) => s.commands ?? []);
    expect(tab("headless")).toEqual(expect.arrayContaining([INSTALL_COMMAND, PAIR_COMMAND, SERVICE_COMMAND, LINGER_COMMAND]));
    expect(tab("linux")).toEqual([INSTALL_COMMAND, PAIR_COMMAND, SERVICE_COMMAND]);
  });

  test("nothing on the page asks for a phone: people install from their laptop", () => {
    const words = JSON.stringify(INSTALL_SECTIONS) + agentInstructions("headless") + agentInstructions("mac");
    expect(words).not.toMatch(/phone/i);
  });
});

describe("the downloads are the router's stable addresses", () => {
  test("every link is one the router redirects, with no version in it", () => {
    expect(everyLink.length).toBeGreaterThan(0);
    for (const { href } of everyLink) {
      expect(ROUTER).toContain(`"${href}":`);
      expect(href).not.toMatch(/\d+\.\d+\.\d+|github/);
    }
  });
});

describe("the instructions for an agent", () => {
  test.each(["mac", "linux", "headless"] as const)("%s: install, pair, keep running, report, in that order", (tab) => {
    const text = agentInstructions(tab);
    const order = [INSTALL_COMMAND, PAIR_COMMAND, SERVICE_COMMAND, STATUS_COMMAND].map((c) => text.indexOf(c));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the person approves the pairing; the agent is told never to", () => {
    for (const tab of ["mac", "linux", "headless"] as const) {
      expect(agentInstructions(tab)).toContain("never approve it yourself");
      expect(agentInstructions(tab)).toContain("Don't use sudo");
    }
  });

  // Tex texts the same prompt when someone asks it to set up their computer (`apps/mcp/src/machines/setupPrompt.js`).
  test.each(["mac", "linux", "headless"] as const)("%s: Tex hands the very same words as this page", (tab) => {
    expect(setupPrompt(tab)).toBe(agentInstructions(tab));
  });

  test("linger is a Linux step, so the Mac's instructions leave it out", () => {
    expect(agentInstructions("headless")).toContain(LINGER_COMMAND);
    expect(agentInstructions("mac")).not.toContain(LINGER_COMMAND);
  });
});

describe("the app's Connect a machine screen", () => {
  test("gives a command that exists, and links the full guide", () => {
    expect(CONNECT).not.toContain('"npx @supa-media/context machine"');
    expect(CONNECT).toContain("const COMMAND = INSTALL_AND_PAIR_COMMAND;");
    expect(INSTALL_AND_PAIR_COMMAND).toBe(`${INSTALL_COMMAND} && ~/.context-machine/bin/${PAIR_COMMAND}`);
    expect(CONNECT).toContain('const GUIDE_HREF = "/download?tab=headless"');
  });
});
