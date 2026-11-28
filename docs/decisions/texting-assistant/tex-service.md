# Tex becomes its own service

Decided by the owner, 2026-11-28.

## What

Tex moves out of the gateway Worker into a Worker of its own, built and
deployed from a private repository. It is a client of Context: it reaches
notes, the calendar, mail and the rest only through one gateway entrypoint,
acting as the person under their grant, with the same tools and the same
privacy check as the app and every AI client.

What stays in Context, because the non-negotiables put it there:

- A person's Tex tables stay in their personal workspace object, and a group
  chat's sealed home stays where it is; Tex reads and writes them through the
  entrypoint.
- Vault credentials are still decrypted only in the gateway; Tex asks for a
  fill and never holds the sealed store.
- A step nobody can take back (an email, a handle claim, a vault key's first
  use) still waits for a yes the gateway checks, never the model.

Tex gets no power through the entrypoint that the person could not use
through MCP, apart from its own tables, a vault fill and finding a person by
phone. Its Worker runs in the gateway's Cloudflare account, since a Durable
Object answers only to Workers in its own account.

## How it is held

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
entrypoint's checks once it is its own service. Delete the guard and the list
can grow unseen. Sabotage: add an import of any gateway module to a Tex file,
and `node scripts/check-tex-boundary.mjs` fails naming it.
