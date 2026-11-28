# Tex becomes its own service

Decided by the owner, 2026-11-28.

## What

Tex moves out of the gateway Worker into a Worker of its own, built and
deployed from a private repository. Context is the MCP server, and Tex is an
MCP client of it like any other (Dev, 2026-11-28): it reaches notes, the
calendar, mail and the rest only through MCP, acting as the person under
their grant, with the same tools and the same privacy check as the app and
every AI client. Tex's memory is notes in the person's workspace. Outside MCP
are only three small calls: finding whose grant a phone number is, a vault
fill that never lets a credential leave Context, and the app or a timer
reaching Tex.

What stays in Context, because the non-negotiables put it there:

- A person's Tex tables stay in their personal workspace object, and a group
  chat's sealed home stays where it is; Tex reads and writes them over MCP.
- Vault credentials are still decrypted only in the gateway; Tex asks for a
  fill and never holds the sealed store.
- A step nobody can take back (an email, a handle claim, a vault key's first
  use) still waits for a yes the gateway checks, never the model.

Tex gets no power the person could not use through MCP, apart from the
three calls above. Its Worker runs in the gateway's Cloudflare account, since a Durable
Object answers only to Workers in its own account.

## How it is held

Every tool call Tex makes goes through one file,
`packages/tex/gateway/contextMcp.js`, which takes an MCP `tools/call`
request's params. Today it answers in-process through the gateway's MCP
dispatcher; when Tex moves to its own Worker, that file switches to MCP over
a service binding and no caller changes. `apps/mcp/test/texContextMcp.test.mjs`
fails if any other Tex file imports the dispatcher.

Until the split is done, the two sides are one program: Tex's code imports
gateway modules and gateway code imports Tex's.
`scripts/check-tex-boundary.mjs` (run by the fast guards and `pnpm precheck`)
holds both directions to the list in `scripts/tex-boundary.json`: an import of
a module the list does not name fails, and a listed module nothing imports
any more fails too, so the list is cut down in the pull request that cut the
tie. It started at 74 gateway modules imported by Tex and 84 Tex modules
imported by the gateway. Test files are left out.

## What a simplification would cost

Adding a new tie to the list to get a change through grows the work the split
has to undo, and every tie is a place where Tex could reach past the
checks MCP applies once it is its own service. Delete the guard and the list
can grow unseen. Sabotage: add an import of any gateway module to a Tex file,
and `node scripts/check-tex-boundary.mjs` fails naming it.
