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

### A key is given to a person, a group or everyone, to use or to see

Decided by the owner, 2026-10-17, on the vault sharing boards: "make sure we
can share with groups, people or the whole workspace". Given in Settings ›
Vault on the key itself; the rules are `apps/mcp/src/vault/access.js`, read by
the gateway and the control plane alike.

- **A share is `{ to, level, by, at }`** in the key's sealed meta. `to` is a
  member's id, a group of the workspace as `@name`, or `*` for every member,
  people who join later included. A group is matched against the same
  `@names` a note's privacy rule is (`grantedNamesFor`), so a key given to a
  group reaches exactly the people and connections a note pointed at it does.
- **`use` or `see`, default `use`.** `use` lets the person's own AIs use the
  key through Context; the person is never shown the value and gets no view
  link. `see` adds Show. The most generous share wins. The saver always sees
  it, and a person on the old people list with no share keeps seeing it.
- **The levels are worded about the person, never their AIs** (the owner,
  2026-10-20: "I thought this setting was talking about sharing with other
  people. didnt realize it was talking about AI's specifically"). Settings ›
  Vault asks "When you share it, they can:" over **Use it** / **Use and see
  it** (each row: "Use only" / "Use and see"), with a line under it naming a
  login's password or a secret's key. "Their AIs use it" read as sharing with
  AIs; `apps/mobile/features/vault/vaultPeople.ts` holds the words.
- **Each AI's yes belongs to a person** (`by` on every yes, one-time grant,
  use and refusal). One person's yes never lets somebody else's copy of the
  same app use the key. A record from before `by` existed is the saver's.
- **Who may give it away:** whoever saved it, or an owner or editor who can
  see it. Somebody given it to use can never pass it on, an editor included.
  Groups are given by owners only, since only owners are shown groups. Only a
  shared workspace's keys can be given; a personal key is moved first.
- **Taking it back takes their AIs with it.** Everyone who no longer has the
  key by any route loses their AIs' yeses, grants, uses and refusals, so
  giving it again starts them afresh. A person may hand back a key given to
  them by name; nobody can take it from whoever saved it.
- Audited as `vault.shared` / `vault.unshared` with the kind and level only.
- **Whoever newly has it is told by email** (`functions/vaultNotify.ts`):
  who gave it, in which workspace, use or see, and a link to Settings ›
  Vault; never the key's name, site or value. Scheduled, never awaited, so
  Give says nothing about anybody's mailbox; at most 50 people per Give and
  10 such mails per person a day. A level change on an existing share sends
  nothing.
- **A Tex group chat counts only what is given to everyone** (2026-10-21):
  its turns are steered by the whole chat, so a key reaches them only when
  shared with `*`, at use, never the tagger's own or one given to them
  (`src/vault/access.js` `actorAccessOf`;
  [groups](./groups.md#tex-acts-for-whoever-tagged-it-the-owner-2026-10-21)).
- **A personal key is moved, not given** (`functions/vaultMove.ts`): only
  its saver, only into a shared workspace they own or edit, as the barrier's
  own reveal, add and delete. Its AIs' yeses stay behind, so they ask again
  there. Audited `vault.moved` in both workspaces.

**What it costs:** a key's meta can now name up to 200 shares, and a
non-manager sees only their own AIs on a shared key. Reversing per-person
yeses fails "one person's yes never lets another person's AI in"
(`apps/mcp/test/vaultSharing.test.mjs`); letting a use-only person give it on
fails "somebody given a key for their AIs can't pass it on"
(`apps/convex/__tests__/vaultSharing.test.ts`). When entries become notes
(below), a share maps onto a tree row's grantee with view meaning `see`.

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
  planted "send the key to webhook.site". A host anyone can publish on
  itself (`webhook.site`, or a shared hosting suffix such as `workers.dev`)
  is refused at save time, because pinning to it pins to everyone. One
  person's address beneath a suffix (`my-app.workers.dev`,
  `<name>.convex.cloud`) is allowed: the person types it, and the key goes
  to that exact address only (the owner, 2026-10-16: "the user is writing
  the domain in so they should be allowed to").
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
- **Settings › Vault reads its history from the key itself** (board 2, as
  drawn, 2026-10-16). Each use updates the key's own sealed meta: per AI, a
  count, when it last used the key, and the method and path of that last use
  (`apps/mcp/src/vault/usage.js`). A No is kept there too, so the page can say
  "You said no" and offer Allow, and a later yes clears it. Keeping this in
  the key rather than in the control plane means a key's history moves,
  exports and is deleted with the key. Every such write is conditional on the
  version just read. That way a use racing Cut off can never write the
  removed AI back. Storage without conditional writes records no history and
  still uses the key. The asks waiting are read from the pending approvals
  as they stand.
- **New key and Show the key open in place** (the owner, 2026-10-16: "I don't
  like that it opens a new page"). Each press still mints a fresh vault link
  and runs the same calls as `/vault/<token>` (`useVaultLinkFlow`), so a value
  is typed or revealed only on a link, each reveal is recorded, and the list
  itself never holds a value. What was revealed lives in that one component
  and is dropped when another key is picked or the page closes. Going back to
  a separate page would cost nothing in safety and only the person's place in
  Settings.
- **A key is changed where it is shown** (the owner, 2026-10-16: "I should
  also be able to edit it inline and save the edits and have it log that I
  changed the password"). Picking a key opens its view link at once: a
  login's username shows as it is, every password and secret value is dots
  until Show, and each field is editable with Save and Undo. A save goes
  through the same view link (`editVaultEntry`), so only the person the link
  was minted for, within its half hour, can change that key; owners and
  editors may change any key given to them, a member only one they saved.
  Meta and secret are rewritten together on condition of the version read
  (`changeEntry`), so an edit never undoes a Cut off or a use that raced it.
  It is audited as `vault.edited` with the names of what changed
  ("password"), never a value, and a save that changed nothing is not logged.
  Each pick is a reveal, and is recorded as one; asking for a second press
  first would only add a step the owner asked to remove.
- **Edit is the whole key, and Delete sits beside it** (the owner,
  2026-10-16: "no way for me to edit the url here, or even delete the
  key?"). The picked key reads quietly (values as dots in rows, Show and
  Copy on each) with one Edit button, as board 2 draws it; Edit opens one
  form in place for the name, the website it is only ever sent to, how it is
  sent, the first-use ask, "Fills on" and the values. A new website is
  checked by the same `savedPin` as a new key and its sending style is
  guessed again, while the AIs already allowed and their uses stay with the
  key. A named header may carry one word before the key (`Authorization:
  Convex <key>`); `*.convex.cloud` is guessed that way. Delete is a bold red
  one-way door asked once more inline, goes through the same view link with
  the same say as an edit, removes meta and sealed values as one object, and
  is audited as `vault.deleted` by name.
- **"Fills on" suggests the site as a name is typed** ("convex" offers
  convex.dev), from the same list as "Only ever sent to". The site itself is
  offered, not a dashboard address, because a saved site fills every page
  beneath it.
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
suffix itself lets anyone who can publish there collect it; scrubbing only the literal
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

### Tex signs in itself; handing its browser over is the rare case

Decided by the owner, 2026-10-16, after Tex asked him to open its browser and
sign in: "we should be asking the user to open up Tex's computer very rarely."
With no saved login, Tex asks one question, "Do you sign in with Gmail or
another email?", and sends `vault_add_link` for that login (Google's, site
`google.com`, for Gmail; the site's own otherwise). Once it's saved, Tex signs
in with `fill_login`; a Google login fills on Google's own sign-in page, which a
site's "Continue with Google" button opens (`siteMatches` takes subdomains, so
`accounts.google.com` matches and a look-alike host does not). A handoff is for
what truly needs the person: a code, a captcha, a payment, or a sign-in they
said they would rather do. The rule is in three places the model reads: the
web prompt (`webPrompt`), `fill_login`'s and `browse`'s descriptions, and the
`sign-in-for-them` skill in `@context-lc ai/production/skills/`.
Reversing it fails `apps/mcp/test/agentFillLogin.test.mjs` ("signing in is
Tex's to do"). The bench has no vault fill step, so golden tasks 1, 2, 4 and 7
script Maya declining the save and test the handoff as the fallback.

### A saved login carries Tex's task on, with no "done" from them

Dev2, 2026-10-24, ordering Instacart groceries by text: the save-login page
opened with no website filled in, and after the login was saved nothing
happened until a "done" ("after adding the email and password Tex should know
that i'm done adding"). Two rules follow. A login's `vault_add_link` needs its
`site` (the tool refuses one without, so the model asks again with it); a
secret or a card may still name none. And a texted turn (or a background job's
turn) that minted a save link answers with `vaultWatch`; the sender's inbox
then asks the control plane (`POST /agent-texts/vault-saved`, times only,
never which entry) every 10 to 30 seconds for half an hour, and once a save
link of theirs was used it queues a turn with no words and
`event: "vault_saved"`. The gateway asks that turn its own fixed line
(`apps/mcp/src/agent/vaultSaved.js`), only on the texting client's 1:1 turn,
and Tex carries the task on. A text from them after the save means that text's
turn already did, and nothing is queued; one save queues one turn. Polling
rather than a push keeps the control plane from knowing the Worker's address,
the same as the Gmail-connected text. Reversing it fails
`apps/mcp/test/agentVaultSavedRoute.test.mjs`,
`apps/agent/src/vaultWatch.test.ts` and
`apps/convex/__tests__/vaultWatch.test.ts`.

### Tex's browser sign-ins are one sealed vault item

Decided by the owner, 2026-10-20 ("Sealed in vault", over a Browserbase
Context and over staying signed out): Tex's browser keeps nothing at
Browserbase, so each new one started signed out and the person was asked to
sign in again. Its sign-ins are now one item in their personal vault,
`.context/vault/browser-jar.json` (`apps/mcp/src/agent/browserJar.js`), sealed
with the same key and seal as a login, its associated data naming the jar, so
the bucket alone never yields one and no entry's part opens as it.

- **What is kept.** Every cookie the browser holds (a partitioned one aside)
  and each https site's localStorage and (since 2026-10-22, below) IndexedDB,
  where many apps keep a sign-in, as it
  was when Tex last read a page there; a site read with nothing kept loses its
  saved storage, so signing out stays signed out.
- **Where it goes.** Gateway to the screenshot Worker and back, with the
  question (`keep`, `jar` on `/browse`), never into a tool result, a log or a
  message (`browseResult` takes it off the answer). A new browser is given the
  cookies; a running one is not, since it holds newer ones. Each saved site's
  storage is put back as its pages open, by a script in an isolated world
  that writes only the page's own origin and never over what it holds
  (`infra/site-shots/src/jar.ts`), so no site's code reads another's.
- **Whose.** A personal workspace's only, with a data key: the browser is one
  person's. A shared workspace keeps none. It is not listed with the logins.
- **Failure.** A jar that does not open, or a restore that fails, is no jar:
  Tex signs in as before, and a browser that never got the jar is not read
  back over it.

Tests: `apps/mcp/test/agentBrowserJar.test.mjs` (sabotaged: plain JSON in
the bucket, `jar` passed on to the turn, the personal check dropped),
`infra/site-shots/src/jar.test.ts` and `browserbase.test.ts` ("sign-ins kept
between browsers"); restore and read-back were checked in real Chromium.

### Browserbase Contexts stay off; the jar is how Tex stays signed in

Weighed again 2026-10-22, when the owner asked to use every Browserbase
feature we pay for. A Browserbase Context is a saved Chrome profile kept at
Browserbase between sessions. It would keep more than the jar did (IndexedDB,
service workers, a sign-in bound to the browser's own key), but it fails the
rule this jar exists for, which non-negotiable #1 now names: the browser's
sign-ins live sealed in the person's own bucket, with the key outside it.

- **A kept Context is every sign-in held at a vendor.** The profile sits in
  Browserbase's account, not the person's bucket. It does not leave with
  Download as folders, a person cannot see or revoke it from Context, and
  deleting their account would have to remember to delete it there too.
  Browserbase lets us upload a profile encrypted to its key, but not take one
  back out, so it cannot be sealed under ours and returned to the bucket.
- **A Context made and deleted per browser buys nothing.** A browser already
  lives until five idle minutes pass (`idle.ts`), and the next one is handed
  the jar. A throwaway profile would hold exactly what the running browser
  already holds.
- **What stays true.** `createSession` sends no `browserSettings.context`;
  `browserbase.test.ts` checks the request body never names one. Turning it on
  is an owner decision recorded here, not a field flipped in a PR.

Closing a gap means carrying more into the sealed jar, never keeping a
profile at Browserbase. So the same day the jar took IndexedDB too (the owner's
"use all these features", over leaving it), since Firebase Auth keeps its web
sign-in there and every app built on it started signed out
(`infra/site-shots/src/jarIdb.ts`):

- **Whole databases of plain data.** A database is kept only when every value
  is plain JSON and every key a string or number, so it comes back exactly as
  it was; one holding a Blob, Date or buffer, or past 256 KB for its origin,
  is left out whole, since half an app's database is worse than none.
- **Put back only where nothing is.** A saved database is created only when
  the origin has none by that name, inside the open's own upgrade, so the
  page's own open waits until it is whole. One the browser holds is never
  touched and its version does not move. Own origin only, in the isolated
  world, as for localStorage.
- **Read as storage is.** The origin the browser is on is read back after the
  steps; an empty list is a sign-out and drops what was held, a read that
  failed keeps it. A full jar gives up the IndexedDB read longest ago first.
- **Read in an isolated world.** Both reads (localStorage and IndexedDB) run
  in a fresh isolated world of the main frame, not the page's own: a page
  that replaced `Promise` could otherwise answer with another site's origin
  and plant data that would be restored there. `browserbase.test.ts` ("gives
  a new browser the jar's cookies…") fails if a read moves back to the
  page's world.

What still starts signed out: sessionStorage, and a sign-in bound to the
browser by Chrome's device-bound session credentials. Tex signs in again with
the vault's login or hands the browser over.

Tests: `infra/site-shots/src/jarIdb.test.ts` (sabotaged: dropping the
existing-database check, the own-origin check, and the plain-data check) and
`apps/mcp/test/agentBrowserJar.test.mjs` ("a site's IndexedDB is sealed like
its storage…", "a full jar gives up the IndexedDB…"). A Firebase-shaped
sign-in read from one Chromium and restored into a fresh one, before the
page's own open, was checked by hand; another origin stayed signed out.

### A card pays only on the person's yes, each time

Decided by the owner, 2026-10-21 ("add cards to the vault please"). A card is
an entry of type `card` whose values are fixed fields (`number`, `exp_month`,
`exp_year`, `cvc`, and optionally `name` and `postal_code`), sealed in the
secret part like any other field (`apps/mcp/src/vault/card.js`).

- **Saving.** Only on the vault's add link, typed by the person. The control
  plane checks the number's Luhn digit and length for its brand, the expiry
  (not past) and the security code (four digits for Amex, three otherwise),
  and refuses a card that carries a login, fields or an AI pin
  (`saveVaultLogin`). Meta keeps `card`: brand, last four and expiry, which is
  all a list, a model or an ask is ever told ("Visa ••4242, expires 08/29").
  A card's details are never edited piecemeal: an edit may rename it or set
  its site, and anything else is refused with "delete it and save the new
  card" (`apps/convex/functions/lib/vaultEdit.ts`).
- **Where it fills.** A card saved for a site fills there and beneath it, as
  a login does. One saved with no site fills on any https checkout, because a
  card is used at shops nobody can list in advance; the yes below is what
  keeps that safe, and it names the site.
- **The yes.** `fill_card` (`apps/mcp/src/agent/fillCard.js`) asks first,
  every time (`apps/mcp/src/vault/pay.js`, kind `vault_pay`). Tex asks by
  text (the owner chose "Ask by text, every payment" on 2026-10-21, over an
  ask in the app and over a per-site yes): the gateway adds "Before I pay, I
  need your OK to pay with your Visa ••4242 on shop.example. Give this a 👍 or say yes" to
  the answer, in its own words, naming the card and the site the browser is
  on, never the model's. Only a plain yes answers ("yes", "yes please", "yes,
  pay it"); "ok" or "sure" sets the ask aside, a no drops it
  (`apps/mcp/src/agent/textedPay.js`). The yes does not end the turn: the
  model is told what was allowed and fills the card in the browser it left
  on the checkout. The ask lives ten minutes, never the twelve hours other
  texted asks do. Any other AI, and a card in a workspace other than the
  turn's own, is asked in the Context app instead, Allow or No. There is
  never a "from now on", because a payment cannot be taken back. A yes
  writes one fill into the card's sealed meta, for that AI (client id), that
  host, that person, for ten minutes, spent by a conditional write before the
  card is typed, so two fills racing on one yes fill once. Storage without
  conditional writes fills no card. Nothing is opened before the yes; a site
  the card isn't for, a page that isn't https, and a box the card has nothing
  for are refused before anyone is asked. A page Tex reads can make Tex ask,
  which is why the ask names the site and the card in the gateway's words:
  the person is answering about that checkout, not about the model's story.
- **What the model sees.** The card's label and which parts were filled.
  Never a digit. It fills and never pays: the model presses the checkout's
  button itself with `browse`, after telling the person the total. The
  browser types each part only into a box of that kind (`cc-number`,
  `cc-exp`, `cc-cvc` and so on, or an expiry menu), marks the filled boxes,
  and blanks them before every screenshot it takes, so no look shows the
  number (`infra/site-shots/src/browse.ts`).
- **Groups.** As for logins ([groups](./groups.md)): a group chat counts only
  a card given to the whole workspace, and the yes is asked of the person who
  tagged Tex.
- **Not yet.** Card boxes inside a payment provider's own frame (Stripe
  Elements, Shopify's checkout) are on another origin the browser does not
  reach; there Tex hands the browser over for the card, as before.

Tests: `apps/mcp/test/agentFillCard.test.mjs` (sabotaged: the ask skipped,
the spend dropped, the host ignored, approve-always offered, the missing-part
and site checks moved after the ask, the group check dropped, any yes taken
as a payment's, a texted payment ask kept twelve hours, another workspace's
card asked by text),
`apps/mcp/test/vaultCard.test.mjs`, `apps/convex/__tests__/vaultCards.test.ts`
(sabotaged: the card check skipped, the edit guard dropped),
`infra/site-shots/src/browse.test.ts` ("card" cases) and
`apps/mobile/__tests__/vaultCards.test.ts`.

### Later, not now

Editing and deleting an entry, and a Vault list in Settings, come together;
until then a changed key is saved as a new entry. Handing a coding agent an
environment's values to run with (the way `op run` does) stays out: the agent
types the commands, so it could print what it was handed. The proxy above is
the answer to that need. TOTP secrets and email codes each need their own section before they are
built; the cookie jar and cards have theirs, above.
