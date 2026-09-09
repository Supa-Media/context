#include <argon2.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* A second-language reader for encryptionPassphraseVector.fixtures.json. */
int main(void) {
  static const char passphrase[] = "correct horse battery staple";
  static const uint8_t salt[16] = {
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  };
  uint8_t output[32];
  int result = argon2id_hash_raw(
    2, 19456, 1, passphrase, strlen(passphrase), salt, sizeof(salt), output, sizeof(output)
  );
  if (result != ARGON2_OK) {
    fprintf(stderr, "argon2id failed: %s\n", argon2_error_message(result));
    return 1;
  }
  for (size_t index = 0; index < sizeof(output); index += 1) printf("%02x", output[index]);
  putchar('\n');
  memset(output, 0, sizeof(output));
  return 0;
}
