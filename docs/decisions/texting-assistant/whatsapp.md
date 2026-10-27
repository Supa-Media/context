# Tex on WhatsApp through Whapi.Cloud, a linked-device account (the owner, 2026-10-27)

The owner wanted Tex reachable on WhatsApp as well as iMessage, 1:1 and in
groups. Three ways to get there were weighed. The one chosen is Whapi.Cloud:
a WhatsApp account linked to the service as a device, the way WhatsApp Web is
linked to a phone.

## Why Whapi.Cloud

- **Photon** is WhatsApp's official Cloud API route. It carries 1:1 chats
  only, so Tex could not be in a group, and a group is most of what the owner
  wanted.
- **Meta's Cloud API** has a Groups API, but only for an Official Business
  Account, capped at eight participants, joined by invite link only. Since
  2026-01-15 Meta also bars general-purpose AI assistants on the Business API,
  which is what Tex is. Building on it would mean a line that is allowed only
  for a purpose Tex is not.
- **Whapi.Cloud** links a WhatsApp account and reaches 1:1 and group chats
  through the same interface. It is not an official Meta product, and that is
  the accepted risk below.

## The accepted risk: WhatsApp can ban the number

A linked-device account is one WhatsApp can ban at any time, and the owner
accepted that. Tex never texts first on WhatsApp: every WhatsApp chat starts
with someone else's message, and Tex answers it. So a ban cannot be announced
on WhatsApp, because the only channel that could carry the news is the one
that was banned. **iMessage stays Tex's home line.** It is the one line a ban
cannot take, so it is where a person hears that WhatsApp has stopped. A
simplification that makes WhatsApp the home line would make a ban silent.

## One provider adapter, so the provider can be swapped

The provider sits behind two interfaces, and nothing else in the Worker names
Whapi: `Line` in `apps/agent/src/line.ts` for 1:1 chats and `GroupLine` in
`apps/agent/src/groupLine.ts` for groups. Sending, reactions, typing, read
receipts and group membership are called through them. Whapi's wire format
is read in `apps/agent/src/whapi.ts` (sends and the member list) and
`apps/agent/src/whapiInbound.ts` (parsing a delivery). Replacing Whapi with
another provider is a new adapter behind the same two interfaces, not a change
to the assistant.

**What a simplification would cost:** calling Whapi directly from the turn,
the queue or the group code would make a provider change a rewrite of every
path that sends, and would leave the one place the webhook is verified
unclear.

## Who a WhatsApp sender is: the phone WhatsApp registered

A sender is identified by the phone number WhatsApp verified by SMS, the id
`<digits>@s.whatsapp.net`. That is the same kind of fact as the iMessage
sender's number, and the same identity the phone-link flow works from.

WhatsApp also gives a private id, `<digits>@lid`, that hides the phone from
the other side of a chat. Its digits are not a phone number, so a `@lid` is
**never read as a phone**. A participant or sender that arrives only as a
`@lid` becomes `lid:<digits>`, which the control plane treats as someone
unknown: not linked, so no notes. A `@lid` that was read as a phone would
match a stranger's digits to whoever holds that number, and a group answer
could then carry that person's notes into a room they are not in.

**What a simplification would cost:** reading `@lid` digits as a phone links a
stranger to an account they never registered, and that is a disclosure. The
tests that fail if it is reversed are in `apps/agent/src/whapi.test.ts`
(`phoneOfJid` and `personOfJid`) and `apps/agent/src/whapiInbound.test.ts`.

## The webhook is authenticated by a header secret

Whapi does not sign a delivery's body. It can send a header that the owner
sets, so the secret is `WHAPI_WEBHOOK_SECRET`, a random value of at least 16
characters, sent on every delivery as `x-tex-webhook-secret`. The Worker
compares it in constant time, before the body is parsed, and an absent or
short secret refuses everything, the same fail-closed rule as the Sendblue and
Linq webhooks ([the texting assistant](../texting-assistant.md#a-webhook-is-acted-on-only-with-the-lines-secret)).
The URL is the Worker's `/whapi` path. A header secret proves only that the
sender knows the value, so it is a secret held in GitHub's environment, never
in the repository, and a rotation is a new value on both sides.

**What a simplification would cost:** accepting a delivery without the header
lets anyone who finds the URL post a message that Tex reads as a person's, and
answers it with that person's notes. Tests: `apps/agent/src/whapiInbound.test.ts`
(a delivery with no or a wrong secret is refused) and `apps/agent/src/whapi.test.ts`
(the secret comparison).

## Setup is a hand-run workflow, not a deploy step

The channel's webhook settings (the URL, the header, the events, media
download and persistence) are set by `.github/workflows/whapi-setup.yml`, run
by hand against one environment. It is a dry run unless `apply` is ticked, it
prints the settings with the secret masked, and it prints only the channel's
status word and whether the phone is linked, never an id or a number.

Whapi webhooks belong to a channel, not to an environment. Staging and
production pointed at the same channel leave one of them receiving nothing,
and the last apply wins. The workflow says so in its job summary, and each
environment needs its own channel to run both.

The three secrets are optional. With `WHAPI_TOKEN`, `WHAPI_LINE` and
`WHAPI_WEBHOOK_SECRET` absent, the WhatsApp line is simply off: the deploy
skips them with a notice, the Worker's `/health` reports `whapiWebhook` and
`whapiReplies` as false, and the iMessage line is unaffected. A missing WhatsApp
secret is never a failed deploy.

**What a simplification would cost:** making the secrets required fails every
deploy until WhatsApp is set up, which is the wrong direction for an optional
line. Letting the setup run without the dry run means one wrong click points
the live channel at the wrong Worker, with no print of what was sent.

## Tex's own texts stay on iMessage

Decided 2026-10-27, after the owner's check-ins moved to WhatsApp the morning
after they first texted Tex there. Replies go to the chat a text came from, on
either line. A text Tex starts itself (a check-in, reminder or heartbeat, all
through `textRoutine`) goes to the person's home chat (`apps/agent/src/homeChat.ts`):
the last chat they texted from that is not WhatsApp. WhatsApp is home only for
someone who has never texted Tex anywhere else, and one text on iMessage moves
it back.

**What a simplification would cost:** going back to "the last chat they texted
from" moves every check-in to WhatsApp the first time someone tries the add-on
line, which is the line more likely to be dropped (a linked device can be
logged out without warning). `homeChat.test.ts` fails if it is reversed.
