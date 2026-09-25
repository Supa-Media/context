# Gateway protocol: what a CLI learns from the gateway

## A CLI learns its workspaces from `scope_info`, as data

`npx @supa-media/context` has to offer a person their workspaces by name when
it installs into a project, and has to know which one is personal so a
session capture lands in their own inbox. Until now the only statement of that
list was prose: a sentence at connect time and a section of `orient`, neither
meant to be parsed.

`scope_info` takes an optional `workspaces: true` and appends a fenced JSON
block, `[{slug, role, kind, current}]`, built from the same request-scoped
`store.contexts` that `orient` describes. An argument on an existing tool, for
the reason the section above gives: a client that cached its tool list before
this shipped can still pass it. `kind` now travels in `contextsFor`, which had
dropped it.

It widens nothing. The list is exactly the set this grant already covers and
`orient` already names to it; a read-only grant is told its own reach like any
other, and a workspace the person is not a member of is absent because the
control plane never put it in the session.

**What a "simplification" would cost.** A new `list_workspaces` tool reaches
only clients that re-fetch their tool list, which is the failure this file
already records once. Parsing `orient`'s prose instead ties every installed
CLI to a sentence somebody will reword.

**The test that fails if it is reversed:** `apps/mcp/test/scopeInfoWorkspaces.test.mjs`, "scope_info lists the
workspaces a sign-in reaches, as data" and the four tests after it,
including that a workspace outside the grant is never named and that an
undeclared argument is still refused.

## The metadata names the app, so the CLI can hand the browser to it

The CLI receives its OAuth code on a loopback port and serves that page
itself, where the app's components cannot reach. The gateway's optional
`APP_ORIGIN` (set for production and staging in `wrangler.toml`) is published
as `context_app_origin` in the authorization server metadata, https only, and
the CLI's loopback page redirects the browser to `<app>/connect/cli` with only
the outcome; the code never leaves the loopback URL. Unset, as on a
self-hosted gateway, the field is absent and the CLI keeps its own plain page.

**What a "simplification" would cost.** Deriving the app's address from the
gateway's hostname guesses wrong for every self-hosted and staging deployment;
styling the loopback page by hand is a second copy of the design that drifts.

**The test that fails if it is reversed:**
`apps/mcp/test/appOriginMetadata.test.mjs`.
