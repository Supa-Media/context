import { describe, expect, it, jest } from "@jest/globals";

const mockNativeArgon2id = jest.fn(async () => new Uint8Array(32).fill(7));

jest.mock("../features/console/encryption/nativeCrypto", () => ({
  __esModule: true,
  hasNativeNoteCrypto: () => true,
  nativeArgon2id: mockNativeArgon2id,
  nativeRandomBytes: () => new Uint8Array(16).fill(1),
}));

import {
  MOBILE_MAX_KDF_MEMORY_KIB,
  derivePassphraseKey,
  type KdfDescriptor,
} from "../features/console/encryption/kdf";

const descriptor = (memory: number): KdfDescriptor => ({
  id: "argon2id",
  v: 0x13,
  m: memory,
  t: 2,
  p: 1,
  salt: "ABEiM0RVZneImaq7zN3u_w",
});

describe("the native mobile KDF resource boundary", () => {
  it("refuses more than 64 MiB before invoking the native bridge", async () => {
    mockNativeArgon2id.mockClear();
    await expect(
      derivePassphraseKey("correct horse battery staple", descriptor(MOBILE_MAX_KDF_MEMORY_KIB + 1)),
    ).rejects.toThrow(/more memory than the mobile app permits/);
    expect(mockNativeArgon2id).not.toHaveBeenCalled();
  });
});
