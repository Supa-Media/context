# Vendored Argon2 reference implementation

- Source: <https://github.com/P-H-C/phc-winner-argon2>
- Release: `20190702`
- Commit: `62358ba2123abd17fccf2a108a301d4b52c01a7c`
- License: CC0 or Apache-2.0; see `LICENSE` in this directory.

Only the reference implementation and its BLAKE2b dependency are included.
The checked-in copy differs from that commit only by removing trailing
whitespace from `LICENSE` and the final blank line in `src/encoding.c`;
`SHA256SUMS` pins the resulting repository bytes. The mobile native-vector test
verifies that manifest, compiles those sources, and checks their output against
the repository's pinned passphrase fixture.
