# @supa-media/context-encryption-decryptor

Offline, zero-dependency decryptor for [Context](https://github.com/Supa-Media/context)'s
encrypted notes. If you exported your workspace's data key with
`export_encryption_keys` (or the console's export action) and revoked or lost
access to Context, this is the whole of what you need to read your notes back
— your bucket, this package, and a Node.js runtime with Web Crypto. No
gateway, no control plane, no network access.

The format this opens is specified, not just implemented, in
[`docs/decisions/encryption.md`](../../docs/decisions/encryption.md). This
package is the reference decryptor for that spec; it is deliberately written
independently of the gateway's own encryption module
(`apps/mcp/src/encryption.js`) rather than importing it, so that a bug shared
by both would be caught by `test/decrypt.test.mjs` rather than hidden by it.

## Getting it

> **Not on npm yet.** The `npx` lines below are what this package is *for*,
> and they will 404 until somebody dispatches
> `.github/workflows/publish-decryptor.yml` — publishing is a deliberate act
> here, never a side effect of a merge. Until then, and always as a fallback
> for anyone who would rather not fetch a tarball from a registry to read
> their own notes:
>
> ```sh
> git clone https://github.com/Supa-Media/context.git
> node context/packages/encryption-decryptor/bin/decrypt.js keys.json ./my-bucket
> ```
>
> That is the whole install. There is nothing to build and nothing to
> install: zero dependencies, plain Node.js Web Crypto, and the two files
> under `bin/` and `src/` are the entire program. Copy them somewhere and
> keep them beside your exported key file if you like — this package is meant
> to still work on a machine with no network at all.

## Usage

```sh
# Decrypt one note, to stdout
npx @supa-media/context-encryption-decryptor keys.json 1-projects/secret.md

# Decrypt one note, to a file
npx @supa-media/context-encryption-decryptor keys.json 1-projects/secret.md out.md

# Decrypt a whole exported bucket (or any folder within it). Everything
# that isn't an encrypted .md note — plaintext notes, privacy.md,
# attachments — is copied through unchanged.
npx @supa-media/context-encryption-decryptor keys.json ./my-bucket ./my-bucket-decrypted
```

`keys.json` is the document `export_encryption_keys` returns: a versioned
bundle naming every live key generation in your workspace, so notes from
before and after a rotation both open with the same file.

Exit code `0` means every note it touched opened. `2` means at least one note
could not be opened — most likely because it was wrapped under a generation
this key file does not carry, which is unusual but not fatal: everything else
in the run still lands in the output directory, and the note that failed is
left out rather than copied through as ciphertext under a name that looks
like a plaintext note.

## What this is not

This is a **decryptor**, not a key manager or a client. It does not talk to
Context, it does not manage rotation, and it does not encrypt anything. If
you are looking to keep using Context normally, you do not need this at all
— it exists for the day you might not be.

## Development

```sh
pnpm --filter @supa-media/context-encryption-decryptor test
```
