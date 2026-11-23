# A Lab change updates the Lab docs

Decided by the owner, 2026-11-23: "make it a standing rule in ci, claude.md and
project rules to update these docs as updates are made to the lab and sandbox".

## The rule

How to change search, Tex, Tex's quality and the nightly quickly is written in
three places, and a pull request that changes the Lab, its test chats, its
bench or the previews updates the one it touches in the same pull request:

- [`docs/lab.md`](../../lab.md), for people: the ladder, and how to change each
  part;
- [`docs/preview-sandbox.md`](../../preview-sandbox.md), for a pull request's
  preview;
- `tex_dev { action: "guide" }`, for agents
  (`packages/lab/gateway/texDev/guide.js`).

The Context note `products/tex/how-it-works/making-changes-in-the-lab.md` in
`@supa` follows the same change.

`scripts/check-lab-docs-updated.mjs` enforces it in the fast guards: a pull
request that changes `packages/lab/` (gateway, app, src), `packages/sandbox/src/`
or a preview or Lab workflow, and none of the three guides, fails. Tests and
generated files alone need nothing. A change that alters nothing a person or
agent does through them (a bug fix, a refactor) says so in its description on
a line of its own:

    No Lab docs change: <why, in at least a few words>

## Why

The Lab is the fast loop: a draft and a run in seconds, not a pull request per
idea ([lab.md](../../lab.md)). A guide that is one Lab change behind sends the
next person or agent back to the slow loop, or to an action that no longer
answers. Nobody checks a guide after it is written, so the pull request that
changes the Lab is the only moment it is cheap to fix.

## What reversing it costs

Dropping the guard lets the guides drift one change at a time, unseen. The
guard's `--self-test` fails if the verdict stops catching a Lab change without
a guide, and `node scripts/precheck.mjs --self-test` fails if the step leaves
`fast-guards.yml`.
