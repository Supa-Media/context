/**
 * The half of "Let Tex use this Mac" that touches the machine: registering it,
 * keeping its grant in the keychain, starting and restarting the bundled
 * runner, and holding the Mac awake while it is plugged in.
 * `core/machine/runner.ts` decides everything and carries the reasoning.
 *
 * Electron is injected (`power`, `spawn`, the keychain store), so the suite
 * drives this file with fakes, the same split `main/localAgent.ts` uses.
 *
 * ## Order on turning it on
 *
 * 1. `context-machine key` makes (once) and prints this Mac's Ed25519 public
 *    key. The private key never leaves the runner's data directory.
 * 2. If no machine grant is in the keychain yet, POST `/machines/register`
 *    with the person's console grant: turning the switch on is their yes, so
 *    there is no code to type. The answer's grant goes straight into the
 *    keychain.
 * 3. The grant is written to a 0600 file in a fresh directory, the runner is
 *    started with its path, and the file is deleted at the first status line
 *    or when the runner exits, whichever is first.
 *
 * Turning it off stops the runner (SIGTERM, then SIGKILL after 10 s) and
 * forgets nothing on the server: the machine shows offline. "Disconnect this
 * machine" on the Tex page is what revokes the grant; a 401 from register or
 * a runner exiting with code 3 (grant refused) clears the stored grant so the
 * next start registers again.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OFF_STATUS,
  keyArgv,
  machineName,
  readKeyAnswer,
  readRegistration,
  readStatusLine,
  registerUrl,
  restartDelayMs,
  runArgv,
  wantsAwake,
  type MachineStatus,
} from "../core/machine/runner.ts";
import type { TokenStore } from "../core/sync/tokenStore.ts";

/** The runner's exit code for "the gateway refused this grant". */
export const EXIT_GRANT_REFUSED = 3;

export interface RunnerChild {
  readonly pid?: number;
  stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): void } | null;
  on(event: "exit", fn: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface MachineRunnerDeps {
  /** The bundled binary, or null where this build carries none. */
  binary: string | null;
  /** Under `userData`: the runner's key lives here, and the per-start grant directory. */
  dataDir: string;
  /** The console's own grant (the person's connection), used once to register. */
  consoleToken: () => Promise<string | null>;
  endpoint: () => string | null;
  /** The machine grant, kept by `safeStorage` in its own file. */
  grantStore: TokenStore;
  computerName: () => string;
  /** One-shot command, e.g. `run` from `platform/exec.ts`. */
  exec: (command: string, args: readonly string[]) => Promise<string>;
  spawn: (command: string, args: readonly string[]) => RunnerChild;
  fetch: typeof fetch;
  power: {
    onBattery: () => boolean;
    onChange: (fn: () => void) => void;
    /** Returns an id for `release`. */
    holdAwake: () => number;
    release: (id: number) => void;
  };
  onChange: (status: MachineStatus) => void;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface MachineRunner {
  status(): MachineStatus;
  setEnabled(on: boolean): Promise<MachineStatus>;
  /** On quit: stop the child and release the awake hold. */
  shutdown(): Promise<void>;
}

export function createMachineRunner(deps: MachineRunnerDeps): MachineRunner {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let status: MachineStatus = { ...OFF_STATUS, available: deps.binary !== null };
  let child: RunnerChild | null = null;
  let attempts = 0;
  let restart: unknown = null;
  let awakeId: number | null = null;
  /** Bumped on every enable/disable, so a start that finishes late does not resurrect a stopped runner. */
  let epoch = 0;

  const set = (next: Partial<MachineStatus>) => {
    status = { ...status, ...next };
    syncAwake();
    deps.onChange(status);
  };

  const syncAwake = () => {
    const want = wantsAwake(status, deps.power.onBattery());
    if (want && awakeId === null) awakeId = deps.power.holdAwake();
    if (!want && awakeId !== null) {
      deps.power.release(awakeId);
      awakeId = null;
    }
    status = { ...status, awake: awakeId !== null };
  };
  deps.power.onChange(() => {
    syncAwake();
    deps.onChange(status);
  });

  async function register(publicKey: string, facts: Record<string, unknown>): Promise<{ grant: string; socketUrl: string } | "refused" | null> {
    const endpoint = deps.endpoint();
    const url = endpoint ? registerUrl(endpoint) : null;
    const token = await deps.consoleToken();
    if (!endpoint || !url || !token) return null;
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // Exactly `PairStart`: the gateway refuses any other key (`machineProtocol.schema.json`).
      body: JSON.stringify({ publicKey, name: machineName(deps.computerName()), facts }),
    });
    if (response.status === 401 || response.status === 403) return "refused";
    if (!response.ok) return null;
    const reg = readRegistration(await response.json().catch(() => null), endpoint);
    return reg ? { grant: reg.grant, socketUrl: reg.socketUrl } : null;
  }

  async function start(mine: number): Promise<void> {
    const binary = deps.binary;
    if (binary === null) return set({ state: "unavailable", message: "This build of the app can't run Tex's jobs." });
    set({ state: "starting", message: null });
    let key;
    try {
      key = readKeyAnswer(await deps.exec(binary, keyArgv(deps.dataDir)));
    } catch {
      key = null;
    }
    if (mine !== epoch) return;
    if (!key) return failed("Tex's runner didn't start on this Mac.");

    // The stored grant is `<socketUrl>\n<grant>`: both are needed to start, and neither is a path the page sees.
    let stored = await deps.grantStore.read();
    if (stored === null) {
      let reg;
      try {
        reg = await register(key.publicKey, key.facts);
      } catch {
        reg = null;
      }
      if (mine !== epoch) return;
      if (reg === "refused") return failed("Sign in to Context on this Mac again, then turn this back on.");
      if (reg === null) return failed("Context can't be reached right now. It tries again on its own.", true);
      stored = `${reg.socketUrl}\n${reg.grant}`;
      await deps.grantStore.write(stored);
    }
    const cut = stored.indexOf("\n");
    const socketUrl = stored.slice(0, cut);
    const grant = stored.slice(cut + 1);

    const dir = await mkdtemp(join(deps.dataDir, "grant-"));
    const grantFile = join(dir, "grant");
    await writeFile(grantFile, grant, { mode: 0o600, flag: "wx" });
    let removed = false;
    const removeGrant = () => {
      if (removed) return;
      removed = true;
      void rm(dir, { recursive: true, force: true });
    };
    if (mine !== epoch) return removeGrant();

    let spawned: RunnerChild;
    try {
      spawned = deps.spawn(binary, runArgv({ dataDir: deps.dataDir, grantFile, socketUrl }));
    } catch {
      removeGrant();
      return failed("Tex's runner didn't start on this Mac.", true);
    }
    child = spawned;
    let pending = "";
    spawned.stdout?.on("data", (chunk) => {
      pending += chunk.toString();
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const read = readStatusLine(line);
        if (!read) continue;
        // The runner has read its grant by the time it says anything.
        removeGrant();
        if (read.state === "online") attempts = 0;
        if (mine === epoch) set(read);
      }
    });
    spawned.on("exit", async (code) => {
      removeGrant();
      if (child === spawned) child = null;
      if (mine !== epoch || !status.enabled) return;
      if (code === EXIT_GRANT_REFUSED) {
        // Revoked (disconnected from the Tex page) or unknown: forget it, and the next start registers again.
        await deps.grantStore.clear();
      }
      failed(code === 0 ? null : "Tex's runner stopped. It starts again on its own.", true);
    });
  }

  function failed(message: string | null, retry = false) {
    set({ state: retry ? "offline" : "failed", message, busy: 0 });
    if (!retry || !status.enabled) return;
    const mine = epoch;
    restart = setTimer(() => {
      restart = null;
      if (mine === epoch && status.enabled) void start(mine);
    }, restartDelayMs(attempts++));
  }

  async function stop(): Promise<void> {
    if (restart !== null) {
      clearTimer(restart);
      restart = null;
    }
    const running = child;
    child = null;
    if (!running) return;
    await new Promise<void>((resolve) => {
      const kill = setTimer(() => {
        running.kill("SIGKILL");
        resolve();
      }, 10_000);
      running.on("exit", () => {
        clearTimer(kill);
        resolve();
      });
      running.kill("SIGTERM");
    });
  }

  return {
    status: () => status,
    async setEnabled(on) {
      epoch += 1;
      attempts = 0;
      if (!on) {
        await stop();
        set({ enabled: false, state: "off", slots: 0, busy: 0, message: null });
        return status;
      }
      set({ enabled: true });
      await stop();
      await start(epoch);
      return status;
    },
    async shutdown() {
      epoch += 1;
      await stop();
      if (awakeId !== null) deps.power.release(awakeId);
      awakeId = null;
    },
  };
}
