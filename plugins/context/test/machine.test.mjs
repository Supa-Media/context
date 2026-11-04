/**
 * `npx @supa-media/context machine`: the CLI only downloads the Rust runner
 * and runs it. Everything here runs offline: the network is a fetch stub, the
 * child process a spawn stub, and the file system a temporary folder.
 *
 * ## What this is guarding
 *
 *  1. **What gets executed.** Nothing runs until its SHA-256 matches the
 *     release's published checksum, and a mismatch leaves no file behind.
 *  2. **The arguments.** Everything after `machine` reaches the runner exactly,
 *     including flags the CLI's own parser would otherwise eat.
 *  3. **Where it installs.** The version is validated before it becomes part of
 *     a URL, and the binary lands by an atomic rename, never half written.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as fsp from "node:fs/promises";

import {
  MACHINE_RUNNER_VERSION,
  targetFor,
  readTarEntry,
  parseChecksum,
  runMachine,
} from "../src/machine.js";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A ustar archive holding the given files, the way the release tarball is laid out. */
function tarball(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000755\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** A fetch stub serving a table of URL to body; anything else is a 404. */
function fakeFetch(table, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const body = table[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

/** A child process stub: records its arguments and emits a fixed exit. */
function fakeSpawn(record, { stdout = "", code = 0, signal = null } = {}) {
  return (command, args, options) => {
    record.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (sig) => record.push({ killed: sig });
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    });
    return child;
  };
}

const quietLog = () => {};

/* ------------------------------ targetFor -------------------------------- */

check("linux x64 → x86_64-unknown-linux-musl", targetFor("linux", "x64") === "x86_64-unknown-linux-musl");
check("linux arm64 → aarch64-unknown-linux-musl", targetFor("linux", "arm64") === "aarch64-unknown-linux-musl");
check("darwin x64 → x86_64-apple-darwin", targetFor("darwin", "x64") === "x86_64-apple-darwin");
check("darwin arm64 → aarch64-apple-darwin", targetFor("darwin", "arm64") === "aarch64-apple-darwin");
check("win32 has no target yet", targetFor("win32", "x64") === null);
check("linux ia32 has no target", targetFor("linux", "ia32") === null);
check("freebsd has no target", targetFor("freebsd", "x64") === null);

check("the version constant is 0.1.0", MACHINE_RUNNER_VERSION === "0.1.0");

/* ---------------------------- checksum parsing --------------------------- */

const HEX = "a".repeat(64);
check("parses `<hex>  <filename>`", parseChecksum(`${HEX}  context-machine-x.tar.gz\n`, "context-machine-x.tar.gz") === HEX);
check("parses the binary-mode `<hex> *<filename>`", parseChecksum(`${HEX} *context-machine-x.tar.gz`, "context-machine-x.tar.gz") === HEX);
check("refuses a checksum for a different file", parseChecksum(`${HEX}  other.tar.gz`, "context-machine-x.tar.gz") === null);
check("refuses a malformed checksum", parseChecksum("not-a-hash  context-machine-x.tar.gz", "context-machine-x.tar.gz") === null);

/* ------------------------------ tar reading ------------------------------ */

const archive = tarball({
  "README.txt": "hello",
  "./context-machine": "BINARY-BYTES",
});
check("finds ./context-machine in a tarball", readTarEntry(archive, "context-machine")?.toString() === "BINARY-BYTES");
check(
  "finds a bare context-machine entry too",
  readTarEntry(tarball({ "context-machine": "X" }), "context-machine")?.toString() === "X"
);
check("a tarball without the runner yields null", readTarEntry(tarball({ "other": "X" }), "context-machine") === null);
check(
  "a near-miss name is not the runner",
  readTarEntry(tarball({ "not-context-machine": "X" }), "context-machine") === null
);
check(
  "two runners in one archive are refused, not guessed at",
  (() => {
    try {
      readTarEntry(tarball({ "a/context-machine": "1", "b/context-machine": "2" }), "context-machine");
      return false;
    } catch {
      return true;
    }
  })()
);

/* ------------------------------ runMachine ------------------------------- */

const VERSION = MACHINE_RUNNER_VERSION;
const TARGET = "x86_64-unknown-linux-musl";
const ASSET = `context-machine-${TARGET}.tar.gz`;
const BASE = `https://github.com/Supa-Media/context/releases/download/machine-runner-v${VERSION}`;
const RUNNER_BYTES = Buffer.from("#!/bin/sh\necho runner\n");

/**
 * The release as published. With `tampered`, the archive served is a perfectly
 * valid one holding other bytes, while the checksum is still the real one: only
 * the hash comparison can tell, so the test fails if that comparison goes.
 */
function fixture({ tampered = false } = {}) {
  const tgz = gzipSync(tarball({ "context-machine": RUNNER_BYTES }));
  const served = tampered ? gzipSync(tarball({ "context-machine": Buffer.from("EVIL") })) : tgz;
  return {
    [`${BASE}/${ASSET}`]: served,
    [`${BASE}/${ASSET}.sha256`]: `${sha256(tgz)}  ${ASSET}\n`,
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "context-machine-test-"));
  return { root, dir: join(root, "install") };
}

function deps(over = {}) {
  return {
    platform: "linux",
    arch: "x64",
    env: { CONTEXT_MACHINE_DIR: over.dir },
    homedir: () => "/nonexistent-home",
    fs: fsp,
    fetch: fakeFetch(fixture()),
    spawn: fakeSpawn([]),
    process: new EventEmitter(),
    log: quietLog,
    ...over,
  };
}

// -- a clean install: download, verify, extract, run

{
  const { root, dir } = await sandbox();
  try {
    const calls = [];
    const spawned = [];
    const code = await runMachine(["pair"], deps({ dir, fetch: fakeFetch(fixture(), calls), spawn: fakeSpawn(spawned), env: { CONTEXT_MACHINE_DIR: dir } }));
    const binary = join(dir, "bin", "context-machine");
    check("a fresh install downloads the tarball and its checksum", calls.includes(`${BASE}/${ASSET}`) && calls.includes(`${BASE}/${ASSET}.sha256`));
    check("the installed runner is the verified bytes", (await readFile(binary)).equals(RUNNER_BYTES));
    check("the installed runner is executable", ((await fsp.stat(binary)).mode & 0o111) !== 0);
    const leftovers = (await readdir(join(dir, "bin"))).filter((name) => name !== "context-machine");
    check("no temp file is left beside it", leftovers.length === 0);
    check("then it runs the runner", spawned[0]?.command === binary);
    check("and exits with the runner's code", code === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- a checksum mismatch is refused and writes nothing executable

{
  const { root, dir } = await sandbox();
  try {
    const spawned = [];
    const messages = [];
    const code = await runMachine(
      ["pair"],
      deps({
        dir,
        fetch: fakeFetch(fixture({ tampered: true })),
        spawn: fakeSpawn(spawned),
        log: (line) => messages.push(line),
      })
    );
    check("a checksum mismatch exits non-zero", code !== 0);
    check("a checksum mismatch never runs anything", spawned.length === 0);
    check("a checksum mismatch says so loudly", messages.some((line) => /checksum/i.test(line)));
    const binDir = join(dir, "bin");
    const present = await access(binDir).then(() => readdir(binDir), () => []);
    check("nothing at all is written into the bin folder", present.length === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- a version that is not a plain semver never reaches a URL

{
  const { root, dir } = await sandbox();
  try {
    const calls = [];
    const code = await runMachine(
      ["pair"],
      deps({ dir, env: { CONTEXT_MACHINE_DIR: dir, CONTEXT_MACHINE_VERSION: "0.1.0/../../evil" }, fetch: fakeFetch(fixture(), calls) })
    );
    check("an odd version is refused", code !== 0);
    check("an odd version fetches nothing", calls.length === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- version skip: an installed runner that reports the wanted version is not downloaded

{
  const { root, dir } = await sandbox();
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "context-machine"), "#!/bin/sh\n", { mode: 0o755 });
    const calls = [];
    const spawned = [];
    const probeOut = [];
    const spawnRecording = (command, args, options) => {
      if (args[0] === "--version") {
        probeOut.push({ command, args });
        return fakeSpawn([], { stdout: `context-machine ${MACHINE_RUNNER_VERSION}\n` })(command, args, options);
      }
      return fakeSpawn(spawned)(command, args, options);
    };
    const code = await runMachine(
      ["status"],
      deps({ dir, fetch: fakeFetch(fixture(), calls), spawn: spawnRecording })
    );
    check("the version probe asks the installed binary --version", probeOut.length === 1);
    check("a matching installed runner is not downloaded", calls.length === 0);
    check("a matching installed runner still runs", spawned.length === 1 && code === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- a runner of the wrong version is replaced

{
  const { root, dir } = await sandbox();
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "context-machine"), "old", { mode: 0o755 });
    const calls = [];
    const spawnStub = (command, args, options) => {
      if (args[0] === "--version") return fakeSpawn([], { stdout: "context-machine 0.0.1\n" })(command, args, options);
      return fakeSpawn([])(command, args, options);
    };
    await runMachine(["status"], deps({ dir, fetch: fakeFetch(fixture(), calls), spawn: spawnStub, env: { CONTEXT_MACHINE_DIR: dir, CONTEXT_MACHINE_VERSION: VERSION } }));
    check("a runner of another version is downloaded again", calls.includes(`${BASE}/${ASSET}`));
    check("and replaced by the verified bytes", (await readFile(join(dir, "bin", "context-machine"))).equals(RUNNER_BYTES));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- arguments reach the runner exactly, flags included

{
  const { root, dir } = await sandbox();
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "context-machine"), "#!/bin/sh\n", { mode: 0o755 });
    const spawned = [];
    const passthrough = ["service", "install", "--yes", "-y", "--name", "a b", "--", "--endpoint=x", "pair"];
    const spawnStub = (command, args, options) => {
      if (args[0] === "--version") return fakeSpawn([], { stdout: `context-machine ${MACHINE_RUNNER_VERSION}\n` })(command, args, options);
      return fakeSpawn(spawned)(command, args, options);
    };
    await runMachine(passthrough, deps({ dir, spawn: spawnStub }));
    const run = spawned[0];
    check("the runner receives exactly the args after `machine`", JSON.stringify(run.args) === JSON.stringify(passthrough));
    check("the runner inherits the terminal", run.options?.stdio === "inherit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- signals are forwarded to the child, and its signal exit is reported

{
  const { root, dir } = await sandbox();
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "context-machine"), "#!/bin/sh\n", { mode: 0o755 });
    const proc = new EventEmitter();
    const seen = [];
    const spawnStub = (command, args, options) => {
      if (args[0] === "--version") return fakeSpawn([], { stdout: `context-machine ${MACHINE_RUNNER_VERSION}\n` })(command, args, options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = (sig) => seen.push(sig);
      setTimeout(() => proc.emit("SIGTERM"), 5);
      setTimeout(() => child.emit("exit", null, "SIGTERM"), 20);
      return child;
    };
    const code = await runMachine(["service", "run"], deps({ dir, spawn: spawnStub, process: proc }));
    check("SIGTERM reaches the runner", seen.includes("SIGTERM"));
    check("a signal exit is not reported as success", code !== 0);
    check("the signal listeners are removed when the runner exits", proc.listenerCount("SIGTERM") === 0 && proc.listenerCount("SIGINT") === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- unsupported platforms say so plainly and exit 1, with no network

{
  const calls = [];
  const messages = [];
  const code = await runMachine([], deps({ platform: "win32", arch: "x64", fetch: fakeFetch(fixture(), calls), log: (line) => messages.push(line) }));
  check("Windows exits 1", code === 1);
  check("Windows is named in a plain sentence", messages.some((line) => /windows/i.test(line) && /later/i.test(line)));
  check("Windows fetches nothing", calls.length === 0);
}

/* ------------------------- the real CLI, end to end ---------------------- */

if (process.platform !== "win32") {
  const { root, dir } = await sandbox();
  try {
    await mkdir(join(dir, "bin"), { recursive: true });
    // A stand-in runner that reports its version and echoes its arguments one per line.
    const stub = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "context-machine ' + MACHINE_RUNNER_VERSION + '"; exit 0; fi',
      'for a in "$@"; do printf "[%s]\\n" "$a"; done',
      "exit 7",
    ].join("\n");
    await writeFile(join(dir, "bin", "context-machine"), stub + "\n", { mode: 0o755 });
    const cli = new URL("../cli/context.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [cli, "machine", "service", "install", "-y", "--workspace", "@x", "--endpoint=e"], {
      env: { ...process.env, CONTEXT_MACHINE_DIR: dir, HOME: root },
      encoding: "utf8",
    });
    check("the CLI runs the runner with the args untouched", result.stdout === "[service]\n[install]\n[-y]\n[--workspace]\n[@x]\n[--endpoint=e]\n");
    check("the CLI exits with the runner's exit code", result.status === 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nALL PASS");
