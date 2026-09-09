import CryptoKit
import ExpoModulesCore
import Security

private enum CryptoFailure: Error {
  case invalidInput
  case derivationFailed(Int32)
  case randomFailed(OSStatus)
}

private func decode(_ value: String) throws -> Data {
  guard let data = Data(base64Encoded: value) else { throw CryptoFailure.invalidInput }
  return data
}

private func validateKdf(memory: Int, iterations: Int, parallelism: Int, version: Int, salt: Data) throws {
  guard version == 0x13,
        memory >= 8, memory <= 2 * 1024 * 1024,
        iterations >= 1, iterations <= 16,
        parallelism >= 1, parallelism <= 16,
        memory >= 8 * parallelism,
        salt.count >= 8, salt.count <= 64 else {
    throw CryptoFailure.invalidInput
  }
}

public final class ContextNativeCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextNativeCrypto")

    Function("randomBytes") { (length: Int) -> String in
      guard length > 0, length <= 64 else { throw CryptoFailure.invalidInput }
      var bytes = Data(count: length)
      let status = bytes.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, length, buffer.baseAddress!)
      }
      guard status == errSecSuccess else { throw CryptoFailure.randomFailed(status) }
      return bytes.base64EncodedString()
    }

    AsyncFunction("deriveArgon2id") {
      (passphrase: String, saltBase64: String, memoryKiB: Int,
       iterations: Int, parallelism: Int, version: Int) -> String in
      let salt = try decode(saltBase64)
      try validateKdf(memory: memoryKiB, iterations: iterations, parallelism: parallelism, version: version, salt: salt)
      var password = Data(passphrase.precomposedStringWithCanonicalMapping.utf8)
      var output = Data(count: 32)
      let result = password.withUnsafeMutableBytes { passwordBytes in
        salt.withUnsafeBytes { saltBytes in
          output.withUnsafeMutableBytes { outputBytes in
            argon2id_hash_raw(UInt32(iterations), UInt32(memoryKiB), UInt32(parallelism), passwordBytes.baseAddress, passwordBytes.count, saltBytes.baseAddress, saltBytes.count, outputBytes.baseAddress, outputBytes.count)
          }
        }
      }
      password.resetBytes(in: 0..<password.count)
      guard result == ARGON2_OK.rawValue else { throw CryptoFailure.derivationFailed(result) }
      return output.base64EncodedString()
    }

    AsyncFunction("aesGcmEncrypt") {
      (keyBase64: String, ivBase64: String, plaintextBase64: String, aadBase64: String) -> String in
      let key = try decode(keyBase64)
      let iv = try decode(ivBase64)
      let plaintext = try decode(plaintextBase64)
      let aad = try decode(aadBase64)
      guard key.count == 32, iv.count == 12 else { throw CryptoFailure.invalidInput }
      let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
      return (box.ciphertext + box.tag).base64EncodedString()
    }

    AsyncFunction("aesGcmDecrypt") {
      (keyBase64: String, ivBase64: String, ciphertextBase64: String, aadBase64: String) -> String in
      let key = try decode(keyBase64)
      let iv = try decode(ivBase64)
      let ciphertextAndTag = try decode(ciphertextBase64)
      let aad = try decode(aadBase64)
      guard key.count == 32, iv.count == 12, ciphertextAndTag.count >= 16 else { throw CryptoFailure.invalidInput }
      let split = ciphertextAndTag.count - 16
      let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ciphertextAndTag.prefix(split), tag: ciphertextAndTag.suffix(16))
      return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad).base64EncodedString()
    }
  }
}
