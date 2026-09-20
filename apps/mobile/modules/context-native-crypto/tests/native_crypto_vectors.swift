import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else {
    FileHandle.standardError.write(Data("vector failed: \(message)\n".utf8))
    exit(1)
  }
}

private func requireThrow(_ message: String, _ operation: () throws -> Void) {
  do {
    try operation()
    require(false, message)
  } catch {
    // Rejection is the expected outcome.
  }
}

@main
struct NativeCryptoVectors {
  static func main() throws {
    let salt = "ABEiM0RVZneImaq7zN3u/w=="
    let composed = try ContextNativeCryptoCore.deriveArgon2id(
      passphrase: "café passphrase",
      saltBase64: salt,
      memoryKiB: 64,
      iterations: 1,
      parallelism: 1,
      version: 0x13
    )
    let decomposed = try ContextNativeCryptoCore.deriveArgon2id(
      passphrase: "café passphrase",
      saltBase64: salt,
      memoryKiB: 64,
      iterations: 1,
      parallelism: 1,
      version: 0x13
    )
    require(composed == "El6elNenuSdLeus/GJtxKYWkwyuU20xn2oTGyTga2ks=", "Argon2id key")
    require(decomposed == composed, "NFC normalization")
    requireThrow("mobile memory cap was bypassed") {
      _ = try ContextNativeCryptoCore.deriveArgon2id(
        passphrase: "correct horse battery staple",
        saltBase64: salt,
        memoryKiB: ContextNativeCryptoCore.maximumMobileMemoryKiB + 1,
        iterations: 1,
        parallelism: 1,
        version: 0x13
      )
    }

    let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
    let wrongKey = String(repeating: "/", count: 42) + "8="
    let iv = "EBESExQVFhcYGRob"
    let aad = "Y29udGV4dC1ub3RlLXYxOndzX3N3aWZ0X3ZlY3Rvcg=="
    let plaintext = "QSBmaXhlZCBDb250ZXh0IEFFUyB2ZWN0b3Ig4oCUIGNhZsOpLg=="
    let ciphertextAndTag =
      "PN7+fzGsXpOJGmZpagEdc5YVHS5tpzTFiIvChd7AdLgxj5Sq241i4fV8BvlfmJuWjuKJ11A="

    let encrypted = try ContextNativeCryptoCore.aesGcmEncrypt(
      keyBase64: key,
      ivBase64: iv,
      plaintextBase64: plaintext,
      aadBase64: aad
    )
    require(encrypted == ciphertextAndTag, "AES-GCM ciphertext || 16-byte tag")
    let opened = try ContextNativeCryptoCore.aesGcmDecrypt(
      keyBase64: key,
      ivBase64: iv,
      ciphertextBase64: ciphertextAndTag,
      aadBase64: aad
    )
    require(opened == plaintext, "AES-GCM decrypt")

    var tampered = Data(base64Encoded: ciphertextAndTag)!
    tampered[tampered.startIndex] ^= 1
    requireThrow("tampered ciphertext was accepted") {
      _ = try ContextNativeCryptoCore.aesGcmDecrypt(
        keyBase64: key,
        ivBase64: iv,
        ciphertextBase64: tampered.base64EncodedString(),
        aadBase64: aad
      )
    }
    requireThrow("wrong key was accepted") {
      _ = try ContextNativeCryptoCore.aesGcmDecrypt(
        keyBase64: wrongKey,
        ivBase64: iv,
        ciphertextBase64: ciphertextAndTag,
        aadBase64: aad
      )
    }
    print("native crypto vectors passed")
  }
}
