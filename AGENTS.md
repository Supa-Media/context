# Agent instructions

Read [`CLAUDE.md`](./CLAUDE.md) before changing anything. It holds the
non-negotiables and the pull request flow. Where this file and `CLAUDE.md`
differ, `CLAUDE.md` wins.

After a pull request is open, do not merge or rebase main into the branch
unless GitHub reports a merge conflict (`mergeable_state` `dirty`). The
numbered steps are **Pull request flow** in `CLAUDE.md`.

Tex's code never writes what Tex says: it hands Tex facts as data, and behaviour
is taught by Training conversations or a Lab prompt module. This is a hard rule
for every writer ([no-scripted-wording](./docs/decisions/texting-assistant/no-scripted-wording.md));
`scripts/tex-wording-check.mjs` fails a pull request that adds wording.
