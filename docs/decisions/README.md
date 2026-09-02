# Durable decisions

Things that were argued through once and should not be silently reversed. Each
names what a "simplification" of it would actually cost, and most name the
test that fails if it is reversed.

These lived in `CLAUDE.md` until the file passed 2,700 lines. They moved here
verbatim; nothing was summarised away. `CLAUDE.md` stays short enough to be
read every session and links here. **Read the file covering the area you are
touching before you change behaviour in it**, and add to it when a durable
decision lands.

Code comments and tests across the repo cite these by title — `see CLAUDE.md,
"A guard nobody has checked is not a guard"`. The titles are unchanged, so
those citations still resolve; look for them here rather than in `CLAUDE.md`.

## [Storage, credentials, and the control plane](./storage-and-credentials.md)

- The gateway is a Cloudflare Worker, not Convex
- Credential retrieval takes two independent proofs
- Never cache a decrypted credential across requests
- Scheduling is not calling
- Credential barriers are enumerated, never inferred
- The setup credential is not a stored credential

## [Identity, grants, invitations, and ingestion](./identity-and-access.md)

- Ingestion is on the apex, which makes the reserved-name list a security control
- Mail lands in a personal context and nowhere else
- The privacy tier is a scope on the grant, never an inference from a role
- One connection reaches every context its person belongs to
- A grant is one person's tooling, and the refusal follows the listing
- An invitation is addressed to a string, and its token is stored in the clear
- An invitation is delivered, and the delivery is scheduled rather than sent
- There is no get-invitation-by-token query, and there must not be one
- The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`
- The two onboarding gates ask two different questions
- …and a third question nobody was asking: how do you get one?
- The hook is a capture-only OAuth client, and that is the whole design

## [Privacy, visibility, and sharing](./privacy-and-sharing.md)

- Link previews reveal nothing about a context
- A share link's preview may carry a title; nothing else's may
- A folder link may also name two or three things inside it
- An unlisted share is the third audience, and it is one row rather than a tier
- `privacy.md` is generated, and the console can generate a fresh one
- The visibility tier is displayed, never stored
- The audit trail's `details` are allow-listed, and its `paths` are not gated at all
- A privacy decision is folded, and the fold only ever narrows

## [The MCP gateway: protocol, transport, orientation](./gateway-protocol.md)

- Two MCP eras, two lists, and they must never be merged
- Authority is decided once, never per protocol era
- An absent `Origin` is allowed; `null` is not
- Orientation is the front door, and `index.md` is the part we do not generate
- `search` and `fetch` exist because ChatGPT's chats can call nothing else

## [Search and the derived index](./search.md)

- Search answers from a derived index, and the index is budgeted, filtered, and disposable
- A search reads a ready index, and never builds one
- …and it opens the shards that can answer it, not all of them
- The manifest is the query surface, and the diff moved out from under it
- The console searches through the gateway's search, not a copy of it

## [The mobile app and the console](./app-and-console.md)

- The note count is measured, stamped, and allowed to be a floor
- One runtime version, pinned, and native deps gated behind it
- The native baseline was chosen once, before the first build
- The iOS editor is the web editor, in a WebView, from a committed bundle
- There are two palettes, and a screen may not hold either one
- Offline is a queue and a cache, and a conflict is parked rather than resolved
- A team link's note survives the console's own cold start, and the login gate
- A folder page is a page, and a folder is acted on like a note
- A phone gets a path bar, which is half of the line that was deleted
- A copy is one press, and it is confirmed outside the modal
- A copy on the device is bounded by who read it, when, and whether the server said no

## [Testing and guards](./testing.md)

- A guard nobody has checked is not a guard

## [Vocabulary and the workspace model](./vocabulary-and-workspaces.md)

- Vocabulary
- The workspace model (build this now, it's cheap)
- Deliberately not yet

## [This repository is public, and review is self-review](./repository-and-review.md)

- This repository is public and MIT licensed
