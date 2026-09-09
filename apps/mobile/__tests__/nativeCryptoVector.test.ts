/**
 * Compile the C implementation shipped in iOS and run it over the same pinned
 * fixture consumed by the JavaScript console, gateway and offline decryptor.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = join(__dirname, "../modules/context-native-crypto");
const ARGON = join(MODULE, "ios/vendor/argon2");
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../../mcp/test/encryptionPassphraseVector.fixtures.json"), "utf8"),
) as { passphrase: string; kdf: Record<string, unknown>; kek: string };

describe("the iOS Argon2id implementation", () => {
  let buildDirectory: string;
  let executable: string;

  beforeAll(() => {
    buildDirectory = mkdtempSync(join(tmpdir(), "context-native-crypto-"));
    executable = join(buildDirectory, "argon2-vector");
    execFileSync(process.env.CC ?? "cc", [
      "-std=c99", "-O2", "-pthread",
      `-I${join(ARGON, "include")}`,
      `-I${join(ARGON, "src")}`,
      join(MODULE, "tests/argon2_vector.c"),
      join(ARGON, "src/argon2.c"),
      join(ARGON, "src/core.c"),
      join(ARGON, "src/encoding.c"),
      join(ARGON, "src/ref.c"),
      join(ARGON, "src/thread.c"),
      join(ARGON, "src/blake2/blake2b.c"),
      "-o", executable,
    ]);
  }, 30_000);

  afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

  it("derives the pinned JavaScript/decryptor fixture without changing a byte", () => {
    expect(FIXTURE.passphrase).toBe("correct horse battery staple");
    expect(FIXTURE.kdf).toEqual({
      id: "argon2id", v: 19, m: 19456, t: 2, p: 1, salt: "ABEiM0RVZneImaq7zN3u_w",
    });
    expect(execFileSync(executable, [], { encoding: "utf8" }).trim()).toBe(
      Buffer.from(FIXTURE.kek, "base64").toString("hex"),
    );
  }, 30_000);

  it("loads the native capability optionally, so the same OTA remains safe on old binaries", () => {
    const bridge = readFileSync(join(MODULE, "src/ContextNativeCryptoModule.ts"), "utf8");
    expect(bridge).toContain("requireOptionalNativeModule");
    expect(bridge).not.toMatch(/\brequireNativeModule\s*[<(]/);
  });
});
