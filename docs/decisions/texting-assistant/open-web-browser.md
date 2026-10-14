# The texting assistant — open web lifts the browser's limits

_Part of [the texting assistant](../texting-assistant.md), after "The agent
can click and type, and types only what the person vouched for"._

### Open web lifts the browser's capability limits (2026-10-14)

Decided by the owner, 2026-10-14: "let's remove the safety guards for
browsers. That's just not needed, not yet at least. Let's get all the
capabilities and then we'll rein it back because we don't have the users right
now to worry about it." With `open_web: yes` in the production setup
(`apps/mcp/src/agent/trustedSites.js`):

- **Any words may be typed on any page** — the person's, a note's, anything —
  and the gateway sends no `onlyOn`, so the browser does not re-check the
  page's host at the keys (`apps/mcp/src/agent/browse.js`).
- **A question may take 400 browser steps** (`MAX_STEPS_PER_TURN_OPEN_WEB`;
  the turn's own rounds bind first) **and open 40 pages**
  (`MAX_PAGES_PER_TURN_OPEN_WEB` in `computer.js`), shared by `open_page` and
  `browse`. Still 10 steps a call.
- **The `open_page` and `browse` descriptions drop the address and typing
  rules**, so the model does not refuse what it may now do.

This **knowingly reopens the exfiltration by typing** that the typing rule
closes, as open web (2026-10-11) already did for addresses: a page can ask the
assistant to type the person's notes into a box. It is lifted only under
`open_web: yes`. With it unset — every self-hosted gateway — the address guard,
the typing rule, the host re-check, 40 steps and 5 pages hold unchanged.

What it never lifts, because they are not capability limits:

- the vault's fill step is the gateway's and never a step the model writes; a
  secret is typed only on its entry's exact origin, into the matching kind of
  box, and never shown (`fillLogin.js`, `infra/site-shots/src/browse.ts`);
- `context.lc/vault` pages stay off limits to the browser (`offLimits`);
- private, IP, internal, non-https, port and credential addresses are refused
  by the gateway (`onOpenWeb`) and by `infra/site-shots` (`publicHttpsUrl`);
- a turn that read a page is still marked untrusted, so a tool call that would
  widen who sees a *note* still waits for a yes where agent-egress approvals
  are on ([agent-egress](../privacy-and-sharing/agent-egress.md)). That is
  about notes, not the browser, and does not stop a browser job.

Reining it back is deleting the `open_web` line from the setup note, with no
deploy.

**What a simplification would cost:** dropping the `open_web` condition would
take the typing rule away from every self-hoster too; keeping the rule under
open web would leave the owner's decision undone. The tests that fail are in
`apps/mcp/test/agentOpenWebBrowse.test.mjs` ("with open web, note words may be
typed on a site the person never named, with no site limit" and "without open
web, note words cannot be typed on a site the person never named").
