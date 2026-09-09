import ExpoModulesCore

/** A deliberately thin bridge: all cryptographic behavior lives in the tested core. */
public final class ContextNativeCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextNativeCrypto")

    Function("randomBytes") { (length: Int) -> String in
      try ContextNativeCryptoCore.randomBytes(length: length)
    }

    AsyncFunction("deriveArgon2id") {
      (passphrase: String, saltBase64: String, memoryKiB: Int,
       iterations: Int, parallelism: Int, version: Int) -> String in
      try ContextNativeCryptoCore.deriveArgon2id(
        passphrase: passphrase,
        saltBase64: saltBase64,
        memoryKiB: memoryKiB,
        iterations: iterations,
        parallelism: parallelism,
        version: version
      )
    }

    AsyncFunction("aesGcmEncrypt") {
      (keyBase64: String, ivBase64: String, plaintextBase64: String, aadBase64: String) -> String in
      try ContextNativeCryptoCore.aesGcmEncrypt(
        keyBase64: keyBase64,
        ivBase64: ivBase64,
        plaintextBase64: plaintextBase64,
        aadBase64: aadBase64
      )
    }

    AsyncFunction("aesGcmDecrypt") {
      (keyBase64: String, ivBase64: String, ciphertextBase64: String, aadBase64: String) -> String in
      try ContextNativeCryptoCore.aesGcmDecrypt(
        keyBase64: keyBase64,
        ivBase64: ivBase64,
        ciphertextBase64: ciphertextBase64,
        aadBase64: aadBase64
      )
    }
  }
}
