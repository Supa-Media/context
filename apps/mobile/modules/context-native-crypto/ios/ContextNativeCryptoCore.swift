import CryptoKit
import Foundation
import Security

enum ContextNativeCryptoFailure: Error {
  case invalidInput
  case derivationFailed(Int32)
  case randomFailed(OSStatus)
}

@_silgen_name("argon2id_hash_raw")
private func contextArgon2idHashRaw(
  _ iterations: UInt32,
  _ memoryKiB: UInt32,
  _ parallelism: UInt32,
  _ password: UnsafeRawPointer?,
  _ passwordLength: Int,
  _ salt: UnsafeRawPointer?,
  _ saltLength: Int,
  _ output: UnsafeMutableRawPointer?,
  _ outputLength: Int
) -> Int32

/**
 * The testable core used by the Expo bridge.
 *
 * Mutable `Data` buffers holding keys and plaintext are cleared with `defer`,
 * including thrown paths. That is best-effort hygiene, not a zeroization
 * guarantee: JavaScript and Swift `String` values are immutable, bridge
 * serialization creates copies outside this code's control, and CryptoKit may
 * retain internal key material for the duration of an operation.
 */
enum ContextNativeCryptoCore {
  static let maximumMobileMemoryKiB = 64 * 1024

  private static func decode(_ value: String) throws -> Data {
    guard let data = Data(base64Encoded: value) else {
      throw ContextNativeCryptoFailure.invalidInput
    }
    return data
  }

  private static func reset(_ data: inout Data) {
    data.resetBytes(in: 0..<data.count)
  }

  static func randomBytes(length: Int) throws -> String {
    guard length > 0, length <= 64 else { throw ContextNativeCryptoFailure.invalidInput }
    var bytes = Data(count: length)
    defer { reset(&bytes) }
    let status = bytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, length, buffer.baseAddress!)
    }
    guard status == errSecSuccess else { throw ContextNativeCryptoFailure.randomFailed(status) }
    return bytes.base64EncodedString()
  }

  static func deriveArgon2id(
    passphrase: String,
    saltBase64: String,
    memoryKiB: Int,
    iterations: Int,
    parallelism: Int,
    version: Int
  ) throws -> String {
    let salt = try decode(saltBase64)
    guard version == 0x13,
          memoryKiB >= 8, memoryKiB <= maximumMobileMemoryKiB,
          iterations >= 1, iterations <= 16,
          parallelism >= 1, parallelism <= 16,
          memoryKiB >= 8 * parallelism,
          salt.count >= 8, salt.count <= 64 else {
      throw ContextNativeCryptoFailure.invalidInput
    }

    var passwordBytes = Data(passphrase.precomposedStringWithCanonicalMapping.utf8)
    var output = Data(count: 32)
    defer {
      reset(&passwordBytes)
      reset(&output)
    }
    let result = passwordBytes.withUnsafeMutableBytes { password in
      salt.withUnsafeBytes { saltBytes in
        output.withUnsafeMutableBytes { outputBytes in
          contextArgon2idHashRaw(
            UInt32(iterations), UInt32(memoryKiB), UInt32(parallelism),
            password.baseAddress, password.count,
            saltBytes.baseAddress, saltBytes.count,
            outputBytes.baseAddress, outputBytes.count
          )
        }
      }
    }
    guard result == 0 else { throw ContextNativeCryptoFailure.derivationFailed(result) }
    return output.base64EncodedString()
  }

  static func aesGcmEncrypt(
    keyBase64: String,
    ivBase64: String,
    plaintextBase64: String,
    aadBase64: String
  ) throws -> String {
    var key = try decode(keyBase64)
    let iv = try decode(ivBase64)
    var plaintext = try decode(plaintextBase64)
    let aad = try decode(aadBase64)
    defer {
      reset(&key)
      reset(&plaintext)
    }
    guard key.count == 32, iv.count == 12 else {
      throw ContextNativeCryptoFailure.invalidInput
    }
    let box = try AES.GCM.seal(
      plaintext,
      using: SymmetricKey(data: key),
      nonce: AES.GCM.Nonce(data: iv),
      authenticating: aad
    )
    return (box.ciphertext + box.tag).base64EncodedString()
  }

  static func aesGcmDecrypt(
    keyBase64: String,
    ivBase64: String,
    ciphertextBase64: String,
    aadBase64: String
  ) throws -> String {
    var key = try decode(keyBase64)
    let iv = try decode(ivBase64)
    let ciphertextAndTag = try decode(ciphertextBase64)
    let aad = try decode(aadBase64)
    defer { reset(&key) }
    guard key.count == 32, iv.count == 12, ciphertextAndTag.count >= 16 else {
      throw ContextNativeCryptoFailure.invalidInput
    }
    let split = ciphertextAndTag.count - 16
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: iv),
      ciphertext: ciphertextAndTag.prefix(split),
      tag: ciphertextAndTag.suffix(16)
    )
    var plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    defer { reset(&plaintext) }
    return plaintext.base64EncodedString()
  }
}
