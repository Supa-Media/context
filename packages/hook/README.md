# @context-lc/hook

Saves what an AI coding session learned into your [Context](https://context.lc),
automatically, when the session ends.

```sh
npx -y @context-lc/hook install
```

That signs you in once in your browser and adds a `SessionEnd` hook to
`~/.claude/settings.json`. From then on, when a Claude Code session ends, its
user-visible messages are saved to `0-inbox/` in your own bucket.

## Why this exists

A connected client can call `save_context` when it finishes. Sometimes it does.
The failure is not that agents refuse — it is that a long session ends without
one, and the thing worth keeping was in the part nobody wrote down. This is the
safety net for that, and it does not depend on the agent choosing to cooperate.

It is not a replacement for `save_context`. An agent that files its own
decisions into the right project folder produces something far better than a
transcript in an inbox. This catches the sessions where that did not happen.

## What it sends, and what it does not

**User-visible user and assistant messages. Nothing else.**

A session log on disk holds much more than the conversation: the system prompt,
the model's own reasoning, every tool call and its full result, the contents of
files read along the way, whatever was in the environment when a command ran.
None of that is sent. The rule is an allow-list — a message travels only if its
role is `user` or `assistant` and its content block is declared `text` — rather
than a filter that strips things that look sensitive, because that kind of
filter fails silently and only in the direction that matters.

That is deliberately lossy. A session whose substance was all tool output comes
out thin, and thin is the right failure.

## What it can do to your context

Nothing except add to your inbox.

The hook asks for `context:capture` and no other scope. That grant can write a
capture and **cannot read a single note** — it cannot search, cannot list, and
cannot tell you whether a note exists. A stolen credential from this file is
worth very little, which is the point: it sits on a laptop, unattended, for a
long time.

It appears in Connections in the Context console like any other client, under
the name `Context hook (<your hostname>)`, and is revoked there on its own.

## Where the credential lives

`~/.context/hook.json`, created `0600` inside a `0700` directory, written
atomically. It holds a refresh token and the client id this machine registered.
It is never printed, never passed on a command line, and never written into
your client's settings file — so a `settings.json` you paste into a bug report
carries no secret.

## Commands

```sh
npx -y @context-lc/hook install      # sign in, then add the hook
npx -y @context-lc/hook status       # is this machine signed in?
npx -y @context-lc/hook uninstall    # remove the hook, forget the credential
```

`--endpoint <url>` points it at your own gateway if you self-host.

## Which clients

Claude Code today, because it has a documented `SessionEnd` hook that hands over
the session transcript. Other clients are added when they have an
end-of-session event whose contract can be read rather than guessed — a hook
that silently never fires is worse than no hook, because you would believe your
sessions were being saved.

## Dependencies

None. Node built-ins only, like the gateway, because this is a thing people run
on their own machines and its supply chain should be its own source.
