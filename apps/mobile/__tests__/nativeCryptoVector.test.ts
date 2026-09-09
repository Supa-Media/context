/**
 * Compile the C implementation shipped in iOS and run it over the same pinned
 * fixture consumed by the JavaScript console, gateway and offline decryptor.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = join(__dirname, "../modules/context-native-crypto");
const ARGON = join(MODULE, "ios/vendor/argon2");
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../../mcp/test/encryptionPassphraseVector.fixtures.json"), "utf8"),
) as { passphrase: string; kdf: Record<string, unknown>; kek: string };

const AES_VECTOR = {
  key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  iv: "EBESExQVFhcYGRob",
  aad: "Y29udGV4dC1ub3RlLXYxOndzX3N3aWZ0X3ZlY3Rvcg==",
  plaintext: "QSBmaXhlZCBDb250ZXh0IEFFUyB2ZWN0b3Ig4oCUIGNhZsOpLg==",
  ciphertextAndTag:
    "PN7+fzGsXpOJGmZpagEdc5YVHS5tpzTFiIvChd7AdLgxj5Sq241i4fV8BvlfmJuWjuKJ11A=",
};

function vendoredSourceFiles(directory: string, root = directory): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name);
    if (statSync(absolute).isDirectory()) return vendoredSourceFiles(absolute, root);
    const relative = absolute.slice(root.length + 1);
    return relative === "LICENSE" || /\.[ch]$/.test(relative) ? [relative] : [];
  });
}

describe("the iOS Argon2id implementation", () => {
  let buildDirectory: string;
  let executable: string;
  let swiftExecutable: string | undefined;

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

    if (process.platform === "darwin") {
      const sources = ["argon2.c", "core.c", "encoding.c", "ref.c", "thread.c"];
      const objects = sources.map((source) => {
        const object = join(buildDirectory, `${source}.o`);
        execFileSync(process.env.CC ?? "cc", [
          "-std=c99", "-O2", "-pthread",
          `-I${join(ARGON, "include")}`,
          `-I${join(ARGON, "src")}`,
          "-c", join(ARGON, "src", source),
          "-o", object,
        ]);
        return object;
      });
      const blakeObject = join(buildDirectory, "blake2b.c.o");
      execFileSync(process.env.CC ?? "cc", [
        "-std=c99", "-O2",
        `-I${join(ARGON, "include")}`,
        `-I${join(ARGON, "src")}`,
        "-c", join(ARGON, "src/blake2/blake2b.c"),
        "-o", blakeObject,
      ]);
      objects.push(blakeObject);
      swiftExecutable = join(buildDirectory, "native-crypto-vectors");
      execFileSync("xcrun", [
        "--sdk", "macosx", "swiftc",
        "-module-cache-path", join(buildDirectory, "swift-module-cache"),
        join(MODULE, "ios/ContextNativeCryptoCore.swift"),
        join(MODULE, "tests/native_crypto_vectors.swift"),
        ...objects,
        "-o", swiftExecutable,
      ]);
    }
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

  it("pins every vendored Argon2 source byte to the reviewed manifest", () => {
    const vendor = join(ARGON);
    const entries = readFileSync(join(vendor, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(entries).toHaveLength(15);
    const listed: string[] = [];
    for (const entry of entries) {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(entry);
      expect(match).not.toBeNull();
      const [, expected, relative] = match!;
      listed.push(relative);
      const actual = createHash("sha256").update(readFileSync(join(vendor, relative))).digest("hex");
      expect(actual).toBe(expected);
    }
    expect(listed.sort()).toEqual(vendoredSourceFiles(vendor).sort());
  });

  it("pins the fixed AES ciphertext followed by its 16-byte tag in Web Crypto too", async () => {
    const key = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(AES_VECTOR.key, "base64"),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const encrypted = await webcrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(AES_VECTOR.iv, "base64"),
        additionalData: Buffer.from(AES_VECTOR.aad, "base64"),
      },
      key,
      Buffer.from(AES_VECTOR.plaintext, "base64"),
    );
    expect(Buffer.from(encrypted).toString("base64")).toBe(AES_VECTOR.ciphertextAndTag);
  });

  (process.platform === "darwin" ? it : it.skip)(
    "runs Argon2id/NFC and fixed AES-GCM compatibility and rejection vectors in CryptoKit",
    () => {
      expect(swiftExecutable).toBeDefined();
      expect(execFileSync(swiftExecutable!, [], { encoding: "utf8" }).trim()).toBe(
        "native crypto vectors passed",
      );
    },
    30_000,
  );
});
