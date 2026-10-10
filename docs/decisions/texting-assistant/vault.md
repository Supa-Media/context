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
- **How a model uses one.** `fill_login` (`apps/mcp/src/agent/fillLogin.js`)
  names an entry and the boxes on the page; the gateway reads the origin from
  the browser's last reading, opens the entry with `openForFill`, and sends
  each part to the browser's fill step, which checks the exact origin and the
  kind of box again as it types. A password goes only into an
  `<input type="password">`, so a search box that prints what is typed into
  it, where the next reading would show it, never receives one. Another
  workspace's login is opened through the grant's own `openContext`, so a
  membership the grant lacks is a login that does not exist.

**What a simplification would cost:** sealing the whole entry as one part makes
every listing open passwords; binding nothing but the workspace lets anyone
with bucket write swap a secret onto an entry with a friendlier site. Tests:
`apps/mcp/test/vault.test.mjs` ("a bucket read of a vault entry never yields
the login, its name or its site", "a sealed part opens only as itself", "no
vault tool result ever carries a username or password"),
`apps/mcp/test/agentFillLogin.test.mjs` ("the site is where the browser is")
and `infra/site-shots/src/browse.test.ts` ("puts a password only in a password
box").

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

### A vault holds secrets too: named fields, most with a value for dev, staging and prod

Decided by the owner, 2026-10-10: "make sure the vault works for api keys and
secrets and env variables as well, it should support custom fields but for
most they will need dev, staging and prod environment variables."

- **Two types.** An entry is a `login` (username, password, optional custom
  fields) or a `secret` (fields only). An entry saved before types existed is
  a login. `apps/mcp/src/vault/fields.js` holds the rules.
- **Fields.** Up to 30, each a name (`STRIPE_SECRET_KEY`, `Account number`)
  that is unique ignoring case, and either one value or one each for `dev`,
  `staging` and `prod`, any of which may be blank. Values live in the sealed
  `secret` part. The `meta` part says which environments hold a value, so
  `vault_list` can say "STRIPE_SECRET_KEY [dev, prod]" without opening one.
- **The fill step can type one field.** `openForFill` with `field` (and `env`
  for a per-environment field) answers that one value, under the same rules:
  the person on the people list, the page on the entry's sites. A secret saved
  with no site never fills anywhere.
- **A person sees values on a page an agent asks for.** `vault_view_link`
  mints a `view` request; `/vault/<token>` names the fields, and
  `revealVaultEntry` shows values only to the signed-in person who asked,
  only while they are on the entry's people list, and records
  `vault.viewed` each time. A view link is not spent by a look, so the person
  can reveal, copy and come back to it for its 30 minutes. The page can copy
  one environment as a `.env` file.
- **The barrier's one door.** `runVaultOperation`'s `reveal` is the only
  operation that opens a secret part for anything but the fill step, and
  `revealVaultEntry` is its only caller. No gateway route reaches it.

**What a simplification would cost:** putting values, or field names, in
`meta` would hand them to every `vault_list`; spending a view link on first
open breaks reveal-then-copy on a phone; letting the view page answer any
member turns "given to" into "visible to the workspace". Tests:
`apps/convex/__tests__/vaultSecrets.test.ts` ("a view page names fields
without values, and only a reveal by the person who asked shows them", "a
member it was never given cannot have a view link made for it"),
`apps/mcp/test/vault.test.mjs` ("the fill step types one field for one
environment, on the entry's site only").

### Later, not now

Editing and deleting an entry, and a Vault list in Settings, come together;
until then a changed key is saved as a new entry. Handing a coding agent an
environment's values to run with (the way `op run` does) needs its own
section here: today no model ever sees a value. TOTP secrets, email codes, a
sealed cookie jar and cards each need their own section before they are built.
