# @context-lc/hook

Brackets an AI coding session with your [Context](https://context.lc): the
orientation goes in at the start, what was learned comes back at the end, and
neither depends on the agent remembering to.

```sh
npx -y @context-lc/hook install
```

That signs you in once in your browser and adds two hooks to
`~/.claude/settings.json`:

- **`SessionStart`** puts orientation in front of the model before it answers
  anything, so reading your context stops depending on the agent choosing to.
- **`SessionEnd`** saves the session's user-visible messages to `0-inbox/`, so
  writing back stops depending on it too.

## The session-start hook, and the one real choice in this package

Claude Code injects a `SessionStart` hook's output into the session before the
first turn. That is the only mechanism here that does not rely on an agent
deciding anything, and there are two versions of it:

**By default it injects an instruction** — that this context exists, that the
answer is probably already in it, and to call `orient` before answering. It
needs no read access and it is strictly stronger than a tool description,
because it is in the conversation rather than in a list the model may skim.

**With `--orient` it injects your actual orientation**, fetched at session
start: your front page, what you touched recently, your folders. This is the
strongest version and it costs something real — reading requires read access on
a credential that lives on your laptop unattended. That is why it is a flag you
type rather than a default you discover later.

```sh
npx -y @context-lc/hook install --orient
```

Neither version ever asks for `context:private`. A hook that could read every
note you marked private is past what convenience is worth, so on a
mostly-private context the injected orientation is thin — and says so, rather
than implying your context is empty.

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

By default, nothing except add to your inbox.

The hook asks for `context:capture` and no other scope. That grant can write a
capture and **cannot read a single note** — it cannot search, cannot list, and
cannot tell you whether a note exists. A stolen credential from this file is
worth very little, which is the point: it sits on a laptop, unattended, for a
long time.

`--orient` widens that to `context:read` so the start hook can fetch your
orientation. That is a real widening and the reason it is a flag: the same
credential can then read your team-visible notes. It still never asks for
`context:private`, so notes you marked private stay out of reach either way.

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
