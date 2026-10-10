# The texting assistant — the vault

_Part of [the texting assistant](../texting-assistant.md). The exception it
rests on is non-negotiable #1's last sentence in `CLAUDE.md`._

### A login is sealed in the workspace's own bucket, and only the fill step opens it

Decided by the owner, 2026-10-06. Built 2026-10-10.

- **Where.** `.context/vault/<id>.json` (`VAULT_PREFIX`,
  `packages/shared/src/storageLayout.cjs`), in the bucket of the workspace the
  login belongs to. It travels with the bucket on export and hand-off, sealed.
- **The key.** The workspace data key (`workspaceDataKeys`, sealed by the
  control plane, never in the bucket), expanded with the label
  `context-vault-v1`, so the bucket alone never yields a login. The first save
  creates the data key if the workspace had none. An owner who exports their
  keys can open their own vault without us, which is the exit promise.
- **Two parts.** `meta` (name, sites, people) and `secret` (username,
  password), sealed separately. Each part's associated data binds the
  workspace, the entry id, the part and the generation, so a secret moved onto
  another entry, or into a meta's place, does not open (`apps/mcp/src/vault/seal.js`).
- **Who opens a secret.** `openForFill` (`apps/mcp/src/vault/fill.js`) and
  nothing else. It is not a tool. It takes the live page's origin from the
  browser, never from the model, and refuses unless the caller's person is on
  the entry's people list and the page is the saved site or beneath it
  ("netflix.com" fills `accounts.netflix.com`, never `netflix.com.evil.io`,
  never plain http). The value goes straight into the page.
- **What a model sees.** `vault_list` gives ids, names and sites. No tool
  result, log or message carries a username or password.

**What a simplification would cost:** sealing the whole entry as one part makes
every listing open passwords; binding nothing but the workspace lets anyone
with bucket write swap a secret onto an entry with a friendlier site. Tests:
`apps/mcp/test/vault.test.mjs` ("a bucket read of a vault entry never yields
the login, its name or its site", "a sealed part opens only as itself", "no
vault tool result ever carries a username or password").

### Personal logins stay personal; a shared workspace's vault is shared login by login

Decided by the owner, 2026-10-10: personal logins go in personal vaults,
shared workspaces have shared vaults, and a specific login is given to a
specific person.

- Every entry has a people list. The person who saved it is on it; nobody else
  is until they are given it. Membership of the workspace is not enough to see
  that a login exists.
- Only an entry in a **shared** workspace can be shared, and only with a
  member of it. A personal login is shared by saving it in the shared
  workspace first.
- Once given, the member's own assistants can have it filled for them through
  their own grants, under the same fill rules. They never see it either.

### Saving and sharing are a person's action on a signed-in page; an agent only asks

Decided by the owner, 2026-10-10: "this must be a human action ... the agent
gives me a link where I can share it."

- An agent calls `vault_add_link` or `vault_share_link`. The control plane
  (`/gateway/vault/request`, editor clearance off the grant) records a request
  of ids and times, and answers a link to `/vault/<token>`. An agent's
  suggested name and site ride on the URL; the control plane keeps no part of
  a login.
- The page opens only for the signed-in person whose grant asked, lasts 30
  minutes, and is spent once. Saving and sharing happen in
  `apps/convex/functions/vault.ts`, after that check. The gateway only reads
  the vault; there is no tool that writes one.
- So a steered model cannot save, change or share a login. The most it can do
  is text the person a page where they decide.
- Nobody texts a password. The tool description tells the model to answer a
  password in a message with `vault_add_link`.
- `functions.vault.runVaultOperation` is a credential barrier, pinned in
  `__tests__/structure/analyzer/pins.helpers.ts`. It returns at most an entry's
  name, sites and people.

**What a simplification would cost:** letting the gateway write the vault
gives every prompt injection a way to plant or share a login; a bearer link
without the signed-in check lets whoever holds the link (including the agent's
own browser) press Share. Tests: `apps/convex/__tests__/vault.test.ts` ("only
the person who asked can spend it, and only once", "a request row holds ids
and times, nothing of a login", "a share names a member of a shared workspace,
never a stranger or a personal login").

### Later, not now

TOTP secrets, email codes, a sealed cookie jar and cards. Each needs its own
section here before it is built. A Passwords list in Settings comes with the
first edit or delete.
