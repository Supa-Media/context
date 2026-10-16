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
- A link is spent by the write that landed, not by the press. Save and Share
  check the link, write the bucket, then spend it in one transaction that
  re-checks it, so a storage failure (`VAULT_STORAGE_FAILED`) leaves the same
  link to try again and two racing saves spend it once. An add link reserves
  its entry id on the first try, so a retry rewrites that entry rather than
  leaving a duplicate.
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
own browser) press Share; spending the link before the write strands a person
whose bucket hiccuped with a spent link and nothing saved. Tests:
`apps/convex/__tests__/vault.test.ts` ("only
the person who asked can spend it, and only once", "a request row holds ids
and times, nothing of a login", "a share names a member of a shared workspace,
never a stranger or a personal login"), `apps/convex/__tests__/vaultRetry.test.ts`
("a failed write leaves the link usable…", "two saves at once spend the link
once and write one entry").

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

### An AI uses a key without seeing it: Context adds it on the way out

Shape agreed with the owner, 2026-10-16 ("wouldn't it be the same if you just
proxied network requests through context and had it add the key you
wanted?"). Boards first, then the build: the save page, the vault list, the
first-use ask and the activity log are drawn in the owner's workspace
(@supa `1-projects/vault-key-proxy/`), and nothing below is built until the
owner picks.

This widens the 2026-10-06 rule on one side and keeps it on the other. Still
true: no model ever sees a value, in a tool result, a log or a message. What
changes: the fill step is no longer the only thing that opens a secret for
use. A second opener, the gateway's proxy step, adds one field's value to one
outgoing request.

- **Pinned to one website when saved.** An entry used this way names exactly
  one host (`api.stripe.com`), and how the site wants the key: the sign-in
  header (`Authorization: Bearer`), a header the person names, or a query
  parameter. Exact host only, never "beneath it" as a login's fill allows,
  and https only. A request to any other host goes out without the key; the
  model cannot choose where a key goes, which is the whole defence against a
  planted "send the key to webhook.site". A host anyone can publish under (a
  shared hosting suffix such as `workers.dev`, `ngrok.app`, `github.io`) is
  refused at save time, because pinning to it pins to everyone.
- **The save form suggests the website; it never decides it** (decided by the
  owner, 2026-10-16). As the person types a name or an address, the form
  offers API hosts from a vendored list: about 200 picked by hand
  (`apiHostsTop.ts`, ranked first, with the header or parameter each wants)
  and about 800 from the APIs.guru OpenAPI directory, CC0
  (`scripts/build-vault-api-hosts.mjs`). The list ships in the app rather
  than being looked up, so what a person types is not sent anywhere while
  they type. It drops any host the server would refuse, and the form mirrors
  the shared-suffix list so a refusal is said while typing; a mobile test
  keeps that copy equal to the gateway's. The pin is still checked where it
  is saved and on every use.
- **Blanked from the answer.** Before a response reaches the model the
  gateway replaces the value, and its base64, URL-encoded and hex forms, with
  a fixed marker, in headers and body. An answer it cannot read whole (over the
  size cap, compressed in a way it cannot open) is refused rather than passed
  through unread.
- **The first use by each AI asks the person.** The unit of a yes is one entry,
  one connected client (the grant), one host. The ask reuses the egress gate's
  machinery (`.context/approvals/pending/`, the app's `/approvals` and a texted
  YES, which the gateway reads before any model runs), never anything the
  model can call. A key Tex itself asks for is asked in the app only, so Tex's
  own thread never settles Tex's own ask. The request does not hang while the
  person decides: it answers at once "waiting for <person>'s yes, try again",
  and the ask stays open for ten minutes, after which it is a no. "From now on"
  lasts until the person cuts that client off in Settings › Vault; "just this
  once" lets one request through. The entry's switch "Ask me the first time
  each AI uses it" is on by default; off means every client the person
  connected may use it without asking. "Just this once" is spent with a
  conditional write, so two requests racing on one grant send one key; on
  storage without conditional writes the app refuses "Just this once" and
  says why.
- **Staff open it with a Features switch in the admin console, not a
  deployment variable** (decided by the owner, 2026-10-16: "remove it, make a
  features switch in admin"). `/gateway/binding` carries the switches as
  `features`; only a literal `true` is on, and a missing row is off. A
  self-hosted deployment switches it in its own console the same way.
- **Every use is an audit entry** (`vault.proxied`, `vault.proxy_refused`):
  who, which entry, which environment, method, host and path, status. Never a
  query string, a header value or a body, since those are where a site puts
  what it answered.
- **Two ways in.** (1) A fetch-through-Context argument on an existing vault
  tool (new capability, existing tool: `gateway-protocol.md`) for a plain web
  request from any MCP client. (2) For command-line tools on an agent's own
  computer, the `npx @supa-media/context` CLI runs a local proxy that the tools
  reach through `HTTPS_PROXY`. It terminates TLS with a certificate authority
  it generates on that machine, and hands each request to the gateway, which
  adds the key and makes the call. The machine holds that local certificate and
  a revocable grant, never a key. A Worker cannot be a CONNECT proxy itself,
  which is why the local half exists.
- **What it does not stop.** A model with a yes can do whatever the key lets it
  do on that site: read the customers, refund a charge. Pinning stops the key
  leaving; the key's own permissions stop the rest, so the save page asks for
  the narrowest key the site offers.

**What a simplification would cost:** letting the model name the host turns a
planted instruction into a stolen key; allowing subdomains or a shared hosting
suffix lets anyone who can publish there collect it; scrubbing only the literal
value misses the echo in base64; letting one yes cover every AI makes a steered
client's first use silent. Tests to write with the build: a request to another
host carries no key, an echoed key comes back blanked in each encoding, an
unanswered ask is a no after ten minutes, and a model's own call cannot settle
an ask.

### A vault entry is a Markdown note under `.context/vault/`, with notes' privacy

Decided by the owner, 2026-10-16, with the proxy above: "it should be plain
markdown notes underlyingly, just in the hidden context folder, with all the
extra details needed for settings". Settings › Vault stays the only place
people see the vault; nothing changes on screen. Underneath:

- **One note per entry**, `.context/vault/<id>.md`, replacing the sealed
  `.json` pair. Its front matter is plain: name, type, the pinned host and
  how the site wants the key, the fields and which environments hold a value,
  and the "ask the first time" switch. Like every note, that front matter is
  read from the Convex tree, never from storage, so Settings lists the vault
  the way the sidebar lists notes.
- **Values stay sealed.** The body is one sealed block holding the username,
  password and field values, under the same data key and associated data as
  today (workspace, entry id, generation). Non-negotiable #1's exception is
  unchanged: no value is ever plain in the bucket, and no tool reads the
  block; only the fill step, the proxy step and a person's reveal open it.
- **Who has it is a tree row's access**, the same rows and grantees as notes
  (private, or named people and groups, each with view or edit), replacing the
  entry's own people list. A vault entry always starts private, whatever its
  folder, and only a member of its workspace can be given one. "View" on a
  vault entry means use it and reveal it; it never means an AI may read it.
- **No AI reads a vault note.** `.context/` is system data, so it is never in
  a listing, a search or `read_note`; a vault note is additionally excluded by
  its kind, so a future change that surfaces `.context/` cannot surface it.
- **Export carries it.** Download as folders includes the vault notes with the
  block still sealed, and the owner's exported keys open it, which is the exit
  promise the sealed `.json` kept.

**What it costs:** a bucket read now shows that an entry named "Stripe"
exists and which host it is pinned to; before, the meta part was sealed too.
This follows from plain notes and was put to the owner when they chose them. The test "a bucket read of a vault
entry never yields the login, its name or its site" becomes "never yields the
login or a value", and a new one proves no tool, listing or search returns a
vault note. Built with the proxy, after the boards are picked; entries saved
before then are rewritten into notes by a one-time pass.

### Later, not now

Editing and deleting an entry, and a Vault list in Settings, come together;
until then a changed key is saved as a new entry. Handing a coding agent an
environment's values to run with (the way `op run` does) stays out: the agent
types the commands, so it could print what it was handed. The proxy above is
the answer to that need. TOTP secrets, email codes, a
sealed cookie jar and cards each need their own section before they are built.
