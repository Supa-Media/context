/**
 * "Let Tex use this Mac": the bundled runner's argv, what its output may say,
 * what a register answer may contain, and the supervisor's lifecycle, with a
 * fake runner, keychain, gateway and power source. No Electron, no binary.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing checks:
 *
 *   putting the grant in argv (`--grant <value>`) instead of a file path      2
 *   `readRegistration` dropping the same-host check on socketUrl             2
 *   `wantsAwake` ignoring `onBattery`                                        2
 *   never deleting the grant file at the first status line                   1
 *   not clearing the stored grant on exit code 3                             1
 *   sending `kind` in the register body (PairStart refuses unknown keys)       1
 *   services.ts handing the register the keychain record (`tokens.read()`)   1
 *   `runArgv` leaving out `--machine-id`                                     3
 *   a two-part stored grant (v0.1.70) kept instead of registering again      1
 *   `runnerPath` returning the inherited launchd PATH only                   3
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keyArgv,
  readKeyAnswer,
  readRegistration,
  readStatusLine,
  registerUrl,
  restartDelayMs,
  runArgv,
  runnerBinaryPath,
  wantsAwake,
  machineName,
  runnerPath,
} from "../src/core/machine/runner.ts";
import { createMachineRunner, EXIT_GRANT_REFUSED } from "../src/main/machineRunner.ts";
import { memoryTokenStore } from "../src/core/sync/tokenStore.ts";

const KEY = "A".repeat(43);
const GRANT = "machine-grant-0123456789abcdef";
const ENDPOINT = "https://gateway.example/mcp";

function fakeChild() {
  const listeners = { data: [], exit: [] };
  const child = {
    killed: [],
    stdout: { on: (_e, fn) => listeners.data.push(fn) },
    on: (_e, fn) => listeners.exit.push(fn),
    kill(signal) {
      child.killed.push(signal);
      queueMicrotask(() => child.exit(0));
      return true;
    },
    say(obj) {
      for (const fn of listeners.data) fn(`${JSON.stringify(obj)}\n`);
    },
    exit(code) {
      const fns = listeners.exit.splice(0);
      for (const fn of fns) fn(code);
    },
  };
  return child;
}

async function harness({ registerStatus = 200, registerBody, onBattery = false, binary = "/app/machine-runner/context-machine" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "machine-runner-test-"));
  const spawned = [];
  const posts = [];
  const timers = [];
  const power = { battery: onBattery, holds: 0, released: 0, listeners: [] };
  const grantStore = memoryTokenStore();
  const statuses = [];
  const runner = createMachineRunner({
    binary,
    dataDir,
    consoleToken: async () => "console-token",
    endpoint: () => ENDPOINT,
    grantStore,
    computerName: () => "Ada's MacBook Pro",
    exec: async (_cmd, args) => (args[0] === "key" ? JSON.stringify({ publicKey: KEY, facts: { chip: "M3", memoryGb: 36 } }) : ""),
    spawn: (cmd, args) => {
      const child = fakeChild();
      spawned.push({ cmd, args, child });
      return child;
    },
    fetch: async (url, init) => {
      posts.push({ url, init });
      const body = registerBody ?? { machineId: "m-1", grant: GRANT, socketUrl: "wss://gateway.example/machines/socket" };
      return { status: registerStatus, ok: registerStatus === 200, json: async () => body };
    },
    power: {
      onBattery: () => power.battery,
      onChange: (fn) => power.listeners.push(fn),
      holdAwake: () => (power.holds += 1),
      release: () => (power.released += 1),
    },
    onChange: (s) => statuses.push(s),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  return { runner, dataDir, spawned, posts, timers, power, grantStore, statuses };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

export async function runMachineRunnerChecks(check) {
  // ---- pure decisions ----
  const argv = runArgv({ dataDir: "/d", grantFile: "/d/grant-x/grant", socketUrl: "wss://g/s", machineId: "m-1" });
  check("the runner gets the grant as a path, never as a value", argv.includes("--grant-file") && argv.includes("/d/grant-x/grant"));
  check("the app keeps the Mac awake itself, so the runner is told not to", argv.includes("--no-keep-awake") && argv.includes("--status-json"));
  check("key asks for JSON in the runner's own data directory", keyArgv("/d").join(" ") === "key --data-dir /d --json");
  let threw = false;
  try {
    runArgv({ dataDir: "", grantFile: "/x", socketUrl: "wss://g", machineId: "m-1" });
  } catch {
    threw = true;
  }
  check("an empty data directory is refused, never defaulted to the working directory", threw);
  // The app registers the machine itself, so the runner's folder has no pairing record: without the id it
  // exits at once ("no machine id"), which the switch showed as "Tex's runner stopped" (Dev2, 2026-11-04).
  {
    // launchd starts a Mac app with /usr/bin:/bin:/usr/sbin:/sbin, where neither CLI lives (Dev2, 2026-11-04).
    const path = runnerPath("/Users/a/.nvm/bin:/usr/bin", "/Users/a", "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
    check("the runner's PATH starts with the login shell's", path[0] === "/Users/a/.nvm/bin");
    check("...adds where the CLIs' installers, Homebrew and npm put them", ["/Users/a/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/a/.claude/local"].every((dir) => path.includes(dir)));
    check("...keeps what the app inherited, each directory once and only absolute ones", path.includes("/sbin") && path.filter((dir) => dir === "/usr/bin").length === 1 && runnerPath("rel:/x", "/h", "").split(":")[0] === "/x");
    check("...and works with no login shell answer", runnerPath(null, "/Users/a", undefined).split(":").includes("/opt/homebrew/bin"));
  }
  check("the runner is told its machine id", argv[argv.indexOf("--machine-id") + 1] === "m-1");

  check("a status line reads", readStatusLine('{"state":"online","slots":4,"busy":1}')?.busy === 1);
  check("a line that is not a status is ignored", readStatusLine("Looking for Claude Code…") === null && readStatusLine('{"state":"hacked"}') === null);
  check("absurd counts read as 0", readStatusLine('{"state":"online","slots":9999,"busy":-1}')?.slots === 0);
  check("a long message is cut for a person", readStatusLine(JSON.stringify({ state: "notReady", message: "x".repeat(500) }))?.message?.length === 200);

  check("a key answer needs a 32-byte base64url key", readKeyAnswer(JSON.stringify({ publicKey: KEY })) !== null && readKeyAnswer(JSON.stringify({ publicKey: "short" })) === null);

  const good = { machineId: "m-1", grant: GRANT, socketUrl: "wss://gateway.example/machines/socket" };
  check("a register answer on the same gateway is taken", readRegistration(good, ENDPOINT)?.machineId === "m-1");
  check("a socket on another host is refused: the grant would go there", readRegistration({ ...good, socketUrl: "wss://evil.example/s" }, ENDPOINT) === null);
  check("a plain ws socket is refused off localhost", readRegistration({ ...good, socketUrl: "ws://gateway.example/s" }, ENDPOINT) === null);
  check("a short grant or a strange id is refused", readRegistration({ ...good, grant: "x" }, ENDPOINT) === null && readRegistration({ ...good, machineId: "../m" }, ENDPOINT) === null);
  check("register goes to the gateway's origin only", registerUrl("https://gateway.example/mcp?x=1") === "https://gateway.example/machines/register");
  check("register refuses plain http off localhost", registerUrl("http://gateway.example/mcp") === null && registerUrl("http://localhost:8787/mcp") !== null);

  check("restarts back off and stop growing at 5 minutes", restartDelayMs(0) === 2_000 && restartDelayMs(1) === 4_000 && restartDelayMs(50) === 300_000);
  check("awake while online on power", wantsAwake({ enabled: true, state: "online" }, false));
  check("never held awake on battery", !wantsAwake({ enabled: true, state: "online" }, true));
  check("never held awake when off or offline", !wantsAwake({ enabled: false, state: "online" }, false) && !wantsAwake({ enabled: true, state: "offline" }, false));
  check("the binary is only looked for on macOS and Linux", runnerBinaryPath("/R", "darwin") === "/R/machine-runner/context-machine" && runnerBinaryPath("/R", "win32") === null);
  check("a machine's name loses control characters and has a length", machineName("Mac\u0007\n") === "Mac" && machineName("") === "This Mac" && machineName("x".repeat(99)).length === 60);

  // ---- the supervisor ----
  {
    const h = await harness();
    await h.runner.setEnabled(true);
    const run = h.spawned[0];
    check("turning it on registers once with the console grant", h.posts.length === 1 && h.posts[0].init.headers.authorization === "Bearer console-token");
    const body = JSON.parse(h.posts[0].init.body);
    check("...sending the public key and the Mac's name, never a private key", body.publicKey === KEY && body.name === "Ada's MacBook Pro" && !JSON.stringify(body).includes("private"));
    check("...and nothing the register schema refuses: exactly publicKey, name and facts", Object.keys(body).sort().join(",") === "facts,name,publicKey");
    check("the machine grant is kept in the keychain store", (await h.grantStore.read())?.endsWith(GRANT));
    check("the runner is started", run !== undefined && run.args[0] === "run");
    check("...with the id the register answered", run.args[run.args.indexOf("--machine-id") + 1] === "m-1");
    check("the grant is in no argument", !run.args.some((a) => a.includes(GRANT)));
    const grantPath = run.args[run.args.indexOf("--grant-file") + 1];
    const mode = (await stat(grantPath)).mode & 0o777;
    check("the grant file is 0600", mode === 0o600);
    run.child.say({ state: "online", slots: 4, busy: 0 });
    await flush();
    let gone = false;
    try {
      await stat(grantPath);
    } catch {
      gone = true;
    }
    check("the grant file is deleted once the runner speaks", gone);
    check("online shows on the status", h.runner.status().state === "online" && h.runner.status().slots === 4);
    check("online on power holds the Mac awake", h.power.holds === 1 && h.runner.status().awake);
    h.power.battery = true;
    for (const fn of h.power.listeners) fn();
    check("unplugging releases the hold", h.power.released === 1 && !h.runner.status().awake);

    await h.runner.setEnabled(false);
    check("turning it off stops the runner", run.child.killed.includes("SIGTERM") && h.runner.status().state === "off");
    await h.runner.setEnabled(true);
    check("turning it back on uses the kept grant, no second register", h.posts.length === 1 && h.spawned.length === 2);
    const second = h.spawned[1];
    second.child.exit(EXIT_GRANT_REFUSED);
    await flush();
    check("a refused grant is forgotten, so the next start registers again", (await h.grantStore.read()) === null);
    check("...and a restart is scheduled", h.timers.length >= 1 && h.runner.status().state === "offline");
    const leftovers = (await readdir(h.dataDir)).filter((n) => n.startsWith("grant-"));
    check("no grant directory is left behind", leftovers.length === 0);
    await h.runner.shutdown();
    await rm(h.dataDir, { recursive: true, force: true });
  }
  {
    const h = await harness({ registerStatus: 401 });
    await h.runner.setEnabled(true);
    check("a refused console grant asks the person to sign in again, and does not loop", h.runner.status().state === "failed" && h.timers.length === 0 && h.spawned.length === 0);
    await rm(h.dataDir, { recursive: true, force: true });
  }
  {
    const h = await harness({ registerBody: { machineId: "m-1", grant: GRANT, socketUrl: "wss://evil.example/s" } });
    await h.runner.setEnabled(true);
    check("a register answer pointing elsewhere starts nothing and keeps nothing", h.spawned.length === 0 && (await h.grantStore.read()) === null);
    await rm(h.dataDir, { recursive: true, force: true });
  }
  {
    const h = await harness({ binary: null });
    check("a build without the runner says so before anyone turns it on", h.runner.status().available === false);
    await h.runner.setEnabled(true);
    check("...and turning it on starts nothing", h.spawned.length === 0 && h.runner.status().state === "unavailable");
    await rm(h.dataDir, { recursive: true, force: true });
  }
  {
    // The keychain holds the whole connection record as JSON; sent as a bearer it is always 401,
    // which the switch showed as "Sign in to Context on this Mac again" (Dev2, 2026-11-04).
    const services = readFileSync(new URL("../src/main/services.ts", import.meta.url), "utf8");
    check(
      "the register and the local agent get the connection's access token, never the keychain record",
      /consoleToken: \(\) => connection\.token\(\)/.test(services) && !/tokens\.read\(\)/.test(services),
    );
  }
  {
    // v0.1.70 kept `<socketUrl>\n<grant>` with no id; that grant can't start the runner, so the Mac registers again.
    const h = await harness();
    await h.grantStore.write(`wss://gateway.example/machines/socket\n${GRANT}`);
    await h.runner.setEnabled(true);
    const run = h.spawned[0];
    check(
      "a stored grant with no machine id is dropped, and the Mac registers again and starts with the new id",
      h.posts.length === 1 && run !== undefined && run.args[run.args.indexOf("--machine-id") + 1] === "m-1",
    );
    await rm(h.dataDir, { recursive: true, force: true });
  }
}
