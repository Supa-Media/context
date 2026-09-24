# Storage, credentials, and the control plane

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### The gateway is a Cloudflare Worker, not Convex

Moved to [The gateway is a Cloudflare Worker, not Convex](./storage-and-credentials/credential-basics.md#the-gateway-is-a-cloudflare-worker-not-convex).

### Credential retrieval takes two independent proofs

Moved to [Credential retrieval takes two independent proofs](./storage-and-credentials/credential-basics.md#credential-retrieval-takes-two-independent-proofs).

### Never cache a decrypted credential across requests

Moved to [Never cache a decrypted credential across requests](./storage-and-credentials/credential-basics.md#never-cache-a-decrypted-credential-across-requests).

### Scheduling is not calling

Moved to [Scheduling is not calling](./storage-and-credentials/credential-basics.md#scheduling-is-not-calling).

### Credential barriers are enumerated, never inferred

Moved to [Credential barriers are enumerated, never inferred](./storage-and-credentials/credential-basics.md#credential-barriers-are-enumerated-never-inferred).

### The setup credential is not a stored credential

Moved to [The setup credential is not a stored credential](./storage-and-credentials/credential-basics.md#the-setup-credential-is-not-a-stored-credential).

### Staff is an environment allowlist, never a column

Moved to [Staff is an environment allowlist, never a column](./storage-and-credentials/credential-basics.md#staff-is-an-environment-allowlist-never-a-column).

### Platform credentials seal to a scope, customers' seal to a workspace

Moved to [Platform credentials seal to a scope, customers' seal to a workspace](./storage-and-credentials/credential-basics.md#platform-credentials-seal-to-a-scope-customers-seal-to-a-workspace).

### Anything needed before this table can be read cannot live in it

Moved to [Anything needed before this table can be read cannot live in it](./storage-and-credentials/credential-basics.md#anything-needed-before-this-table-can-be-read-cannot-live-in-it).

### Usage is counted, never logged

Moved to [Usage is counted, never logged](./storage-and-credentials/credential-basics.md#usage-is-counted-never-logged).

### Context-owned objects have one versioned namespace

Moved to [Context-owned objects have one versioned namespace](./storage-and-credentials/versioned-objects.md#context-owned-objects-have-one-versioned-namespace).

### Version history is the customer's object versioning, not a copy we keep

Moved to [Version history is the customer's object versioning, not a copy we keep](./storage-and-credentials/versioned-objects.md#version-history-is-the-customers-object-versioning-not-a-copy-we-keep).

### Dropbox's client secret is optional hardening, not a second credential to guard

Moved to [Dropbox's client secret is optional hardening, not a second credential to guard](./storage-and-credentials/versioned-objects.md#dropboxs-client-secret-is-optional-hardening-not-a-second-credential-to-guard).

## Managed storage: a bucket we run, in an account that holds nothing else

Moved to [Managed storage: a bucket we run, in an account that holds nothing else](./storage-and-credentials/managed-storage.md#managed-storage-a-bucket-we-run-in-an-account-that-holds-nothing-else).

## The migration's outcome is recorded, because an offer nobody can answer is a nag

Moved to [The migration's outcome is recorded, because an offer nobody can answer is a nag](./storage-and-credentials/migration-and-absence.md#the-migrations-outcome-is-recorded-because-an-offer-nobody-can-answer-is-a-nag).

## Absent meant two things, and the bucket is asked which

Moved to [Absent meant two things, and the bucket is asked which](./storage-and-credentials/migration-and-absence.md#absent-meant-two-things-and-the-bucket-is-asked-which).

## A bucket born on the layout has nothing to migrate, and is not asked to

Moved to [A bucket born on the layout has nothing to migrate, and is not asked to](./storage-and-credentials/migration-and-absence.md#a-bucket-born-on-the-layout-has-nothing-to-migrate-and-is-not-asked-to).

## The same absence, in the capability column, made after the rule was written

Moved to [The same absence, in the capability column, made after the rule was written](./storage-and-credentials/migration-and-absence.md#the-same-absence-in-the-capability-column-made-after-the-rule-was-written).

## A conditional write is the guard a conditional delete would have been

Moved to [A conditional write is the guard a conditional delete would have been](./storage-and-credentials/conditional-writes-and-archive.md#a-conditional-write-is-the-guard-a-conditional-delete-would-have-been).

## Which folder is "the archive" is a question, not a constant

Moved to [Which folder is "the archive" is a question, not a constant](./storage-and-credentials/conditional-writes-and-archive.md#which-folder-is-the-archive-is-a-question-not-a-constant).

## A verification snapshot is never read as live state

Moved to [A verification snapshot is never read as live state](./storage-and-credentials/verification-and-model-key.md#a-verification-snapshot-is-never-read-as-live-state).

## The model key is a fourth credential route, not a fifth sibling on the binding

Moved to [The model key is a fourth credential route, not a fifth sibling on the binding](./storage-and-credentials/verification-and-model-key.md#the-model-key-is-a-fourth-credential-route-not-a-fifth-sibling-on-the-binding).

## A live editing room holds note text, and the enumeration does not list it

Moved to [A live editing room holds note text, and the enumeration does not list it](./storage-and-credentials/collaboration-and-live-rooms.md#a-live-editing-room-holds-note-text-and-the-enumeration-does-not-list-it).

## Automatic collaboration extends the storage contract

Moved to [Automatic collaboration extends the storage contract](./storage-and-credentials/collaboration-and-live-rooms.md#automatic-collaboration-extends-the-storage-contract).
