/**
 * `npx @supa-media/context machine <args>`: download the Rust runner, check it,
 * and run it with every argument passed through unchanged.
 *
 * This module has no runner logic. The runner (`context-machine`) does the
 * pairing, the service and the work; this only gets its binary onto the
 * computer and hands it the rest of the command line.
 *
 * ## Order of operations, and why
 *
 * The bytes are fetched and checked before anything is written. A download
 * whose SHA-256 is not the one the release published is refused, and nothing
 * is left on disk that could be run. The binary is written to a temporary file
 * in its own folder, made executable, and renamed into place, so a crash never
 * leaves a half-written runner under the real name.
 *
 * The version becomes part of a download URL, so it must look like a version
 * before it is used. Nothing else in the argument list is interpreted here.
 */

import { randomBytes, createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { homedir as nodeHomedir, constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** The runner release this CLI installs. The tag is `machine-runner-v<version>`. */
export const MACHINE_RUNNER_VERSION = "0.1.0";

const RELEASE_REPOSITORY = "https://github.com/Supa-Media/context";
const BINARY_NAME = "context-machine";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const TARGETS = {
  "linux:x64": "x86_64-unknown-linux-musl",
  "linux:arm64": "aarch64-unknown-linux-musl",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin",
};

/** The release asset's target triple for this platform, or null when there is none yet. */
export function targetFor(platform, arch) {
  return TARGETS[`${platform}:${arch}`] ?? null;
}

/** The checksum a `.sha256` file names for `filename`, or null if it names another file. */
export function parseChecksum(text, filename) {
  const line = String(text).trim().split(/\r?\n/)[0] ?? "";
  const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match) return null;
  if (match[2].trim() !== filename) return null;
  return match[1].toLowerCase();
}

/**
 * The bytes of the one `context-machine` regular file in a ustar tarball, or
 * null when there is none. Two of them is an error: the CLI will not guess
 * which one the release meant.
 */
export function readTarEntry(tar, name) {
  let found = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const fullName = prefix ? `${prefix}/${entryName}` : entryName;
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("the archive has a corrupt header");
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("the archive is truncated");
    const isRunner = fullName === name || fullName.endsWith(`/${name}`);
    if (isRunner && typeflag === "0") {
      if (found) throw new Error(`the archive holds more than one ${name}`);
      found = tar.subarray(dataStart, dataEnd);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return found ? Buffer.from(found) : null;
}

function field(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** Where the runner lives: `${CONTEXT_MACHINE_DIR || ~/.context-machine}/bin/context-machine`. */
export function binaryPath(env, homedir) {
  const base = env.CONTEXT_MACHINE_DIR || join(homedir(), ".context-machine");
  return join(base, "bin", BINARY_NAME);
}

function releaseUrls(version, target) {
  const asset = `${BINARY_NAME}-${target}.tar.gz`;
  const base = `${RELEASE_REPOSITORY}/releases/download/machine-runner-v${version}`;
  return { asset, tarball: `${base}/${asset}`, checksum: `${base}/${asset}.sha256` };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * Run the runner with `args`. Resolves to the exit code the CLI should exit with.
 * Every dependency is injectable so the tests need no network and no real spawn.
 */
export async function runMachine(args, injected = {}) {
  const deps = {
    fetch: globalThis.fetch,
    fs: nodeFs,
    spawn: nodeSpawn,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: nodeHomedir,
    process,
    log: (line) => console.error(line),
    ...injected,
  };
  const say = deps.log;

  const target = targetFor(deps.platform, deps.arch);
  if (!target) {
    if (deps.platform === "win32") say("Running Tex on Windows is not available yet; the machine runner comes to Windows later.");
    else say(`The machine runner has no build for ${deps.platform} ${deps.arch} yet.`);
    return 1;
  }

  const version = deps.env.CONTEXT_MACHINE_VERSION || MACHINE_RUNNER_VERSION;
  if (!VERSION_PATTERN.test(version)) {
    say(`context: "${version}" is not a runner version. Use a version like ${MACHINE_RUNNER_VERSION}.`);
    return 1;
  }

  const binary = binaryPath(deps.env, deps.homedir);
  try {
    if (!(await installedAt(binary, version, deps))) {
      await install(binary, version, target, deps);
      say(`context: installed the machine runner ${version} at ${binary}`);
    }
  } catch (error) {
    say(`context: ${error.message}`);
    return 1;
  }

  return runChild(binary, args, deps);
}

/** True when a runner is already there and reports exactly the wanted version. */
async function installedAt(binary, version, deps) {
  try {
    await deps.fs.access(binary);
  } catch {
    return false;
  }
  const output = await capture(binary, ["--version"], deps);
  return output !== null && output.split(/\s+/).some((token) => token.replace(/^v/, "") === version);
}

function capture(command, args, deps) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = deps.spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

async function install(binary, version, target, deps) {
  const urls = releaseUrls(version, target);
  const tarballResponse = await deps.fetch(urls.tarball);
  if (!tarballResponse.ok) throw new Error(`could not download the machine runner (HTTP ${tarballResponse.status}).`);
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());

  const checksumResponse = await deps.fetch(urls.checksum);
  if (!checksumResponse.ok) throw new Error(`could not download the runner's checksum (HTTP ${checksumResponse.status}). Nothing was installed.`);
  const expected = parseChecksum(await checksumResponse.text(), urls.asset);
  if (!expected) throw new Error("the runner's checksum file does not name this download. Nothing was installed.");

  // Verified before anything is written, so a bad download never touches disk.
  if (sha256(tarball) !== expected) {
    throw new Error("checksum mismatch: the downloaded runner does not match the published checksum. Refusing to install it.");
  }

  const bytes = readTarEntry(gunzipSync(tarball), BINARY_NAME);
  if (!bytes) throw new Error(`the release archive holds no ${BINARY_NAME}. Nothing was installed.`);

  const folder = dirname(binary);
  await deps.fs.mkdir(folder, { recursive: true });
  const temp = join(folder, `.${BINARY_NAME}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await deps.fs.writeFile(temp, bytes, { mode: 0o755 });
    await deps.fs.chmod(temp, 0o755);
    await deps.fs.rename(temp, binary);
  } catch (error) {
    await deps.fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function runChild(binary, args, deps) {
  return new Promise((resolve) => {
    let child;
    try {
      child = deps.spawn(binary, args, { stdio: "inherit" });
    } catch (error) {
      deps.log(`context: could not start the machine runner: ${error.message}`);
      resolve(1);
      return;
    }
    // Each forwarder names its signal, rather than trusting the listener's
    // arguments, so Ctrl-C and a service manager's stop reach the runner alike.
    const forwarders = ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child.kill(signal)]);
    for (const [signal, forward] of forwarders) deps.process.on(signal, forward);
    const done = (code) => {
      for (const [signal, forward] of forwarders) deps.process.removeListener(signal, forward);
      resolve(code);
    };
    child.on("error", (error) => {
      deps.log(`context: could not start the machine runner: ${error.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => {
      if (code !== null) done(code);
      else done(128 + (osConstants.signals[signal] ?? 0));
    });
  });
}
