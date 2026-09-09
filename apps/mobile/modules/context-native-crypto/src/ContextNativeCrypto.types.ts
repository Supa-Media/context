export type ContextNativeCryptoModule = {
  randomBytes(length: number): string;
  deriveArgon2id(passphrase: string, saltBase64: string, memoryKiB: number, iterations: number, parallelism: number, version: number): Promise<string>;
  aesGcmEncrypt(keyBase64: string, ivBase64: string, plaintextBase64: string, aadBase64: string): Promise<string>;
  aesGcmDecrypt(keyBase64: string, ivBase64: string, ciphertextAndTagBase64: string, aadBase64: string): Promise<string>;
};
