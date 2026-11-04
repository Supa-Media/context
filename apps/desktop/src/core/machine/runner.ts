/**
 * "Let Tex use this Mac": the decisions behind carrying the machine runner.
 *
 * The runner is a separate Rust binary (`apps/machine-runner`, workstream 02
 * of "Your machines as Tex minions") that holds one outbound socket to the
 * workspace object and runs Claude Code or Codex for Tex's jobs. The Mac app
 * carries it inside the bundle and starts it; it does not reimplement it. What
 * the app adds is what only the app can do: the person's yes (the toggle), the
 * machine's grant kept in the OS keychain, keeping the Mac awake while it is
 * plugged in, and computer use, which stays the owner's own asks only.
 *
 * Everything here is pure, so the suite checks it with no Electron and no
 * binary: the argv, what a status line means, what a register answer may
 * contain, how long to wait before a restart, and when to hold the Mac awake.
 * `main/machineRunner.ts` is the half that touches the machine.
 *
 * ## The grant never travels in argv or the environment
 *
 * Both are readable by any process of the same user (`ps -E`, `/proc`). The
 * grant goes to the runner as a path to a file created 0600 in a fresh
 * directory of ours, and that file is deleted as soon as the runner says it is
 * up, and in every exit path. Same rule as `main/localAgent.ts`.
 */

/** What the console shows about this Mac's runner. No credential, no path, ever: it crosses the bridge. */
export type MachineRunState = "off" | "unavailable" | "starting" | "online" | "offline" | "paused" | "notReady" | "failed";

export interface MachineStatus {
  /** The runner is in this build and this platform can run it. */
  available: boolean;
  /** The person turned on "Let Tex use this Mac". */
  enabled: boolean;
  state: MachineRunState;
  slots: number;
  busy: number;
  /** The Mac is being kept awake for Tex right now. */
  awake: boolean;
  /** One plain sentence when something needs the person: "Sign in to Claude Code on this Mac". */
  message: string | null;
}

export const OFF_STATUS: MachineStatus = Object.freeze({
  available: false,
  enabled: false,
  state: "off",
  slots: 0,
  busy: 0,
  awake: false,
  message: null,
}) as MachineStatus;

/** The binary's file name inside the bundle's `Resources/machine-runner/`. */
export const RUNNER_BINARY = "context-machine";

/** Where the bundled runner lives, or null where this build does not carry one. */
export function runnerBinaryPath(resourcesPath: string, platform: string): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (!resourcesPath) return null;
  return `${resourcesPath}/machine-runner/${RUNNER_BINARY}`;
}

/** `context-machine key`: make (once) and print this Mac's public key and facts. */
export function keyArgv(dataDir: string): string[] {
  if (!dataDir) throw new Error("machine runner: no data directory");
  return ["key", "--data-dir", dataDir, "--json"];
}

/** `context-machine run`: the grant as a file path, statuses on stdout, the app keeps the Mac awake. */
export function runArgv(options: { dataDir: string; grantFile: string; socketUrl: string }): string[] {
  if (!options.dataDir || !options.grantFile) throw new Error("machine runner: missing paths");
  return [
    "run",
    "--data-dir",
    options.dataDir,
    "--grant-file",
    options.grantFile,
    "--socket-url",
    options.socketUrl,
    "--status-json",
    "--no-keep-awake",
  ];
}

const STATES = new Set<MachineRunState>(["starting", "online", "offline", "paused", "notReady", "failed"]);

/** One line of the runner's stdout, or null for anything that is not a status. Never throws. */
export function readStatusLine(line: string): Pick<MachineStatus, "state" | "slots" | "busy" | "message"> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!STATES.has(r.state as MachineRunState)) return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 64 ? v : 0);
  return {
    state: r.state as MachineRunState,
    slots: count(r.slots),
    busy: count(r.busy),
    // A sentence for a person, kept short; nothing else from the runner reaches the page.
    message: typeof r.message === "string" && r.message.length > 0 ? r.message.slice(0, 200) : null,
  };
}

export interface MachineKey {
  publicKey: string;
  facts: Record<string, unknown>;
}

/** What `context-machine key --json` printed. The key is raw Ed25519, base64url, 32 bytes. */
export function readKeyAnswer(stdout: string): MachineKey | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const r = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const key = typeof r?.publicKey === "string" ? r.publicKey : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const facts = r?.facts !== null && typeof r?.facts === "object" && !Array.isArray(r?.facts) ? (r.facts as Record<string, unknown>) : {};
  return { publicKey: key, facts };
}

export interface Registration {
  machineId: string;
  grant: string;
  socketUrl: string;
}

/**
 * What `/machines/register` answered. The socket must be on the gateway this
 * Mac is connected to: a register answer naming another host would send the
 * machine's grant there on the first connect, so it is refused.
 */
export function readRegistration(body: unknown, endpoint: string): Registration | null {
  const r = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!r) return null;
  const machineId = typeof r.machineId === "string" ? r.machineId : "";
  const grant = typeof r.grant === "string" ? r.grant : "";
  const socketUrl = typeof r.socketUrl === "string" ? r.socketUrl : "";
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(machineId) || grant.length < 16) return null;
  let socket: URL;
  let gateway: URL;
  try {
    socket = new URL(socketUrl);
    gateway = new URL(endpoint);
  } catch {
    return null;
  }
  if (socket.protocol !== "wss:" && !(socket.protocol === "ws:" && isLocal(socket.hostname))) return null;
  if (socket.host !== gateway.host) return null;
  return { machineId, grant, socketUrl: socket.toString() };
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1";

/** Where to register: the gateway's origin, never a path the endpoint chose. */
export function registerUrl(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname))) return null;
    return `${u.origin}/machines/register`;
  } catch {
    return null;
  }
}

/** Wait before restarting a runner that exited badly: 2 s, doubling, at most 5 minutes. */
export function restartDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.min(n, 10));
}

/**
 * Keep the Mac awake only while the runner is up and the Mac is on power
 * (owner's decision, 2026-11-03: "stays awake while plugged in; asleep shows
 * offline and Tex offers the cloud"). On battery it may sleep like any Mac.
 */
export function wantsAwake(status: Pick<MachineStatus, "enabled" | "state">, onBattery: boolean): boolean {
  if (!status.enabled || onBattery) return false;
  return status.state === "online" || status.state === "paused" || status.state === "starting";
}

/** The machine's name as Tex shows it: the Mac's own name, cut to a row's length. */
export function machineName(computerName: string): string {
  const clean = computerName.replace(/[\u0000-\u001f]/g, "").trim();
  return (clean || "This Mac").slice(0, 60);
}
