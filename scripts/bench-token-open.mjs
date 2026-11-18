#!/usr/bin/env node
/**
 * Open the sealed benchmark-runner refresh token a Lab run or a Tex replay
 * hands to the writer job.
 *
 * The job that runs a branch seals the rotated token with RSA-OAEP to a
 * public key made for that run. The private key never enters that job: the
 * key job wraps it with AES under BENCH_SECRET_WRITER_TOKEN, and only the
 * writer job, which checks out main, holds that token and unwraps it. This
 * file is the open. It runs from main's checkout, writes the token to a file,
 * and never prints it.
 *
 *   node scripts/bench-token-open.mjs --private priv.pem --cipher token.bin --out refresh-token
 *   node scripts/bench-token-open.mjs --self-test
 *
 * The openssl flags below are the ones the workflows run. The guard refuses a
 * workflow that seals or wraps with any other flags, so a change here and a
 * change there stay the same change.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** RSA-OAEP, SHA-256 for both the hash and MGF1. openssl 3 defaults are not this. */
export const TOKEN_PKEYOPTS = ["rsa_padding_mode:oaep", "rsa_oaep_md:sha256", "rsa_mgf1_md:sha256"];

/** AES-256-CBC with an explicit iteration count, so two runner images agree. */
export const WRAP_CIPHER = ["-aes-256-cbc", "-pbkdf2", "-iter", "100000", "-salt"];

/** A refresh token this gateway mints: object form, or the legacy crt_ form. */
export const REFRESH_TOKEN = /^(?:crt1\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}|crt_[A-Za-z0-9_-]{43})$/;

const OPENSSL = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";

function openssl(args, env) {
  return spawnSync(OPENSSL, args, { encoding: "buffer", env: env ? { ...process.env, ...env } : process.env });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function decryptFile(privatePath, cipherPath) {
  const result = openssl([
    "pkeyutl",
    "-decrypt",
    "-inkey",
    privatePath,
    ...TOKEN_PKEYOPTS.flatMap((opt) => ["-pkeyopt", opt]),
    "-in",
    cipherPath,
  ]);
  if (result.status !== 0) return { error: "openssl could not open the sealed token" };
  const token = result.stdout.toString("utf8").replace(/\n$/, "");
  if (!REFRESH_TOKEN.test(token)) return { error: `the sealed value is not a refresh token (${token.length} characters)` };
  return { token };
}

function writeToken(path, token) {
  // Exact bytes, no trailing newline. `gh secret set` reads stdin and strips trailing CR/LF only
  // (gh 2.103.0, bytes.TrimRight). A refresh token matches REFRESH_TOKEN, which has neither, so the
  // stored secret equals this file.
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") return { selfTest: true };
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  if (!out.private || !out.cipher || !out.out) fail("need --private, --cipher and --out");
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    selfTest();
    return;
  }
  const opened = decryptFile(args.private, args.cipher);
  if (opened.error) fail(opened.error);
  writeToken(args.out, opened.token);
}

function samples() {
  return [`crt1.pExample.${"A".repeat(43)}`, `crt_${"B".repeat(43)}`];
}

function seal(pub, plainPath, cipherPath) {
  return openssl(["pkeyutl", "-encrypt", "-pubin", "-inkey", pub, ...TOKEN_PKEYOPTS.flatMap((opt) => ["-pkeyopt", opt]), "-in", plainPath, "-out", cipherPath]);
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "bench-token-open-"));
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };
  try {
    const password = "writer-token-fixture";
    const priv = join(dir, "priv.pem");
    const pub = join(dir, "pub.pem");
    const wrapped = join(dir, "priv.enc");
    const unwrapped = join(dir, "unwrapped.pem");
    expect("keygen", openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", priv]).status === 0);
    expect("pubout", openssl(["pkey", "-in", priv, "-pubout", "-out", pub]).status === 0);
    const wrap = openssl(["enc", ...WRAP_CIPHER, "-pass", "env:SEAL", "-in", priv, "-out", wrapped], { SEAL: password });
    expect("wrap", wrap.status === 0 && existsSync(wrapped));
    const unwrap = openssl(["enc", "-d", ...WRAP_CIPHER, "-pass", "env:SEAL", "-in", wrapped, "-out", unwrapped], { SEAL: password });
    expect("unwrap", unwrap.status === 0 && existsSync(unwrapped) && readFileSync(unwrapped).equals(readFileSync(priv)));
    const wrong = openssl(["enc", "-d", ...WRAP_CIPHER, "-pass", "env:SEAL", "-in", wrapped, "-out", join(dir, "nope.pem")], { SEAL: "other-password" });
    expect("a different password does not unwrap", wrong.status !== 0);

    for (const token of samples()) {
      const plain = join(dir, "plain");
      const cipher = join(dir, "cipher.bin");
      const out = join(dir, "out");
      writeFileSync(plain, token, { mode: 0o600 });
      expect(`seal ${token.slice(0, 4)}`, seal(pub, plain, cipher).status === 0 && existsSync(cipher));
      const opened = decryptFile(unwrapped, cipher);
      expect(`open ${token.slice(0, 4)}`, opened.token === token);
      if (opened.token) writeToken(out, opened.token);
      expect(`file ${token.slice(0, 4)}`, existsSync(out) && readFileSync(out, "utf8") === token);
      rmSync(cipher, { force: true });
      rmSync(out, { force: true });
    }

    const garbagePlain = join(dir, "garbage.txt");
    const garbage = join(dir, "garbage.bin");
    writeFileSync(garbagePlain, "not-a-token");
    expect("seal garbage", seal(pub, garbagePlain, garbage).status === 0);
    const refused = decryptFile(unwrapped, garbage);
    expect("refuses a value that is not a refresh token", Boolean(refused.error && refused.error.includes("not a refresh token") && !refused.token));

    const other = join(dir, "other.pem");
    expect("other key", openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", other]).status === 0);
    const plain = join(dir, "plain");
    const cipher = join(dir, "cipher.bin");
    writeFileSync(plain, samples()[0]);
    expect("reseal", seal(pub, plain, cipher).status === 0);
    expect("refuses a different private key", decryptFile(other, cipher).error === "openssl could not open the sealed token");

    const logged = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--private", unwrapped, "--cipher", cipher, "--out", join(dir, "cli-out")], {
      encoding: "utf8",
    });
    expect("cli writes the file", logged.status === 0 && readFileSync(join(dir, "cli-out"), "utf8") === samples()[0]);
    expect("cli does not print the token", !`${logged.stdout}${logged.stderr}`.includes(samples()[0]));
    expect("missing args fail", spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--private", unwrapped], { encoding: "utf8" }).status !== 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Self-test passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
