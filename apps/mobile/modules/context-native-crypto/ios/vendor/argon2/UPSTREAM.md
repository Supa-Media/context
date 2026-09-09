# Vendored Argon2 reference implementation

- Source: <https://github.com/P-H-C/phc-winner-argon2>
- Release: `20190702`
- Commit: `62358ba2123abd17fccf2a108a301d4b52c01a7c`
- License: CC0 or Apache-2.0; see `LICENSE` in this directory.

Only the reference implementation and its BLAKE2b dependency are included.
`apps/mobile/__tests__/nativeCryptoVector.test.ts` compiles these exact files
and checks them against the repository's pinned passphrase fixture.
