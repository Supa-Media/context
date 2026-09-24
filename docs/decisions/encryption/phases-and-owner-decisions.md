# Encryption — phases and owner decisions

### What Phase 1 builds, and what it does not

**Builds:** the envelope format and a pure encrypt/decrypt module in the
gateway; the workspace data key in the control plane behind the existing
credential-reachability guard; the gateway read/write path
encrypting and decrypting at request time; an owner-only tool to turn
encryption on and off for one note; the search exclusion; the move and
link-rewrite safety; the key export; and a locked state in the console.

**Does not build, deliberately:** the passphrase recipient and everything it
implies (client-side Argon2id, an unlock session, idle auto-lock, a change-
password flow); WDK rotation (only the id that makes it possible); encrypted
attachments and images; encrypted note *titles* or paths, which non-negotiable 2
forecloses anyway; the `bucket` and `projection` search opt-ins; and any claim
that we cannot read these notes.

**Phase 2 builds** the first of those lists and nothing else in it: the
`passphrase` recipient and its KDF descriptor, Argon2id in plain JavaScript on
the client, an in-memory unlock session with a manual lock and an idle
auto-lock, a passphrase change that rewraps one recipient without rewriting the
body, the acknowledgement screen, and the guard that stops the gateway writing
over a note it cannot open. It does **not** build: recipient keys for other
people or any way to share a passphrase; unlocking on a phone; encrypted
attachments; a passphrase on a note that also keeps a workspace recipient; or
any recovery path whatsoever, which is the point rather than an omission.

### What Phase 2a adds

**Builds:** workspace-key rotation end to end — `startWorkspaceKeyRotation`
and `completeWorkspaceKeyRotation` in the control plane, both reached only
through `/gateway/binding`'s existing two proofs rather than a third
credential-bearing HTTP route (`CREDENTIAL_HTTP_ROUTES` stays at two members);
`rotate_encryption_keys`, the owner-only, resumable, idempotent gateway tool
that walks the bucket and re-wraps; the `workspaceDataKeys.retiredAt` field and
`workspaceKeyRotations` table; and the grace-period *policy* (retired
generations are never purged automatically). `export_encryption_keys` moves
from a single-generation shape to the versioned, multi-generation bundle this
file specifies above, and gains a matching offline decryptor,
`packages/encryption-decryptor` — an independent reimplementation of the
format, not an import of the gateway's own module, so the two can be checked
against each other. `exportWorkspaceDataKeys` is the second member of
`CREDENTIAL_BARRIERS` (`__tests__/structure.test.ts`) — the first time a
Convex function has been allowed to hand a credential's plaintext back to its
own caller on purpose, because this is the one case in the whole system where
that is the point rather than a bug.

**Does not build:** any operator tool to purge a retired generation, which is
deliberately a manual, documented decision rather than code, at least until an
owner using this in anger asks for one. The console button that calls
`exportEncryptionKeys` **was** on this list — the action shipped built,
owner-gated, rate-limited and audited, with nothing in `apps/mobile`
referencing it — until `apps/mobile/features/console/advanced/` wired it into
the Advanced settings section; see "Revocation and export" above for what that
wiring is.

**A persisted rotation-walk cursor was added after this shipped, once a
measured ceiling made the trade this section originally accepted the wrong
one for a workspace larger than one person's own.** The walk's own progress —
a cursor, a small stuck-note list, nothing that opens a note — now lives at
`.context/rotation-progress.json` in the customer's own bucket, bounding
every call, including the one that completes the rotation, to about the batch
cap rather than the size of the bucket. See "Rotation" above for the current
design and its measured before/after table; `startWorkspaceKeyRotation` and
`completeWorkspaceKeyRotation` are unchanged — the control plane still tracks
only whether a walk may *start*, never how far it has gotten.

**So what could somebody actually reach on the day this merged?** The two MCP
tools, on an owner-tier personal connection, from any client they have
connected — that was the whole of it, and it was enough for the
non-negotiable: an owner could ask their assistant to export their keys and
get the bundle back in the response. The console was not a second door yet, it
was no door — until `apps/mobile/features/console/advanced/` opened one; see
"Revocation and export" above.

**And the decryptor is reachable by `git clone`, not by `npx`, until somebody
dispatches `publish-decryptor.yml`.** The package's README used to open with
three `npx @supa-media/context-encryption-decryptor` lines against a name that
has never been published; it now says so and gives the clone-and-run form
first, and the workflow that would make the `npx` form true exists and is
`workflow_dispatch` only, for the same reason `publish-hook.yml` is. Handing a
tarball to a public registry stays a decision somebody takes. What is not
acceptable is a promise with a broken link in it, which is what the README
was.

**The one question only the owner can answer** is the first of the product
note's own open decisions, restated with what has since been learned: **is a
note allowed to drop its `workspace` recipient — genuinely unreadable by
Supa Media, and therefore invisible to every AI client the customer has
connected?** That is the difference between "encrypted at rest" and what the
product note asked for, it is the whole of Phase 2's scope, and it is a product
call about which failure mode the customer prefers, not an engineering one.

### Additional owner decisions (2026-09-08)

- There are no legacy workspace-key notes requiring migration. Do not invent a
  migration or deletion exception for that nonexistent format.
- Passphrase-protected notes are treated the same as other notes in exports;
  their ciphertext is exported without a special case.
- Export remains owner-only. Sharing a note or its passphrase does not grant
  export authority.
