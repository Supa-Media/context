/**
 * Electron's half of "Let Tex use this Mac": the pieces `machineRunner.ts`
 * takes as dependencies, built from the real app. Nothing is decided here.
 *
 * - The runner binary is `Resources/machine-runner/context-machine` in the
 *   packaged app (electron-builder `extraResources`), absent in a build that
 *   does not carry it, which the page then shows as unavailable.
 * - The machine grant is its own `safeStorage` file (`machine.enc`) beside the
 *   console's `connection.enc`, by the same rules.
 * - Keeping awake is `powerSaveBlocker("prevent-app-suspension")`, held only
 *   while the runner is up and the Mac is on power.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { app, powerMonitor, powerSaveBlocker, safeStorage } from "electron";
import { runnerBinaryPath, runnerPath } from "../core/machine/runner.ts";
import { encryptedFileStore } from "../core/sync/encryptedFileStore.ts";
import { run } from "../platform/exec.ts";
import { createMachineRunner, type MachineRunner } from "./machineRunner.ts";
import type { MachineRunStatus } from "@context/desktop-bridge";

export async function createAppMachineRunner(deps: {
  consoleToken: () => Promise<string | null>;
  endpoint: () => string | null;
  onChange: (status: MachineRunStatus) => void;
}): Promise<MachineRunner> {
  const dataDir = join(app.getPath("userData"), "machine");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const candidate = app.isPackaged ? runnerBinaryPath(process.resourcesPath, process.platform) : process.env.CONTEXT_MACHINE_RUNNER ?? null;
  const binary = candidate !== null && existsSync(candidate) ? candidate : null;

  // The Mac's own name ("Ada's MacBook Pro"), read once; the host name until it answers.
  let computerName = hostname().replace(/\.local$/, "");
  if (process.platform === "darwin") {
    void run("/usr/sbin/scutil", ["--get", "ComputerName"]).then(
      (name) => {
        if (name.trim()) computerName = name.trim();
      },
      () => {},
    );
  }

  // The runner finds `claude` and `codex` on PATH, and launchd gave this app none of the person's.
  // Read the login shell's once (a constant script, no interpolation), and add the CLIs' usual homes.
  let loginPath: string | null = null;
  if (process.platform === "darwin") {
    let shell = "/bin/zsh";
    try {
      const own = userInfo().shell;
      if (own && own.startsWith("/")) shell = own;
    } catch {
      // No passwd entry: the macOS default shell.
    }
    loginPath = await run(shell, ["-lc", 'printf "%s" "$PATH"'], { timeoutMs: 5_000 }).catch(() => null);
  }
  const env = { ...process.env, PATH: runnerPath(loginPath, homedir(), process.env.PATH) };

  const power = new Set<() => void>();
  powerMonitor.on("on-ac", () => power.forEach((fn) => fn()));
  powerMonitor.on("on-battery", () => power.forEach((fn) => fn()));

  return createMachineRunner({
    binary,
    dataDir,
    consoleToken: deps.consoleToken,
    endpoint: deps.endpoint,
    grantStore: encryptedFileStore(app.getPath("userData"), safeStorage, "machine.enc"),
    computerName: () => computerName,
    exec: (command, args) => run(command, args, { timeoutMs: 20_000 }),
    // No shell, and stderr kept off: it can carry a CLI's own output, which is not ours to log.
    spawn: (command, args) => spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"], shell: false, env }),
    fetch: (...args) => fetch(...args),
    power: {
      onBattery: () => powerMonitor.isOnBatteryPower(),
      onChange: (fn) => power.add(fn),
      holdAwake: () => powerSaveBlocker.start("prevent-app-suspension"),
      release: (id) => powerSaveBlocker.stop(id),
    },
    onChange: deps.onChange,
  });
}
