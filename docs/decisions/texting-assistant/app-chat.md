# The Context app's own chat with Tex: its own chat, the same history (2026-11-19, draft)

Dev2, 2026-11-19: "Build a clickable, testable preview of a 1:1 Tex chat inside the Context web app ... a Google OAuth
reviewer, and our demo video, can talk to Tex, approve actions and see results in one place ... reuse the SAME Tex
config and graph that handle incoming Photon texts ... In-app messages must enter that same pipeline and share the
same history ledger as texts." Then, on the approved mockup: "it should be like whatsapp its own thing, but it can
see the same history", and "make sure images, reactions and replies, edits deletes work as well". Draft: nothing
here merges until Dev2 says so.

**Where.** A Tex button on the console's right rail, under the calendar, opens the side panel on a "Tex" tab beside
Meetings (`apps/mobile/features/console/aside/`, `features/tex/chat/`). Only on a personal workspace its owner has
open. This is not the in-app agent removed on 2026-10-10 (which ran on a pasted model key): it is Tex.

**The app is a line, not a second Tex.** A message from the app goes to the gateway's `POST /tex/app-chat`
(`packages/tex/gateway/agent/appChatRoute.js`), which builds what Photon's line hands a chat object (the shapes the Lab's test
chats build, `labSandbox/chatRun.js` `inboundOf`): a text with its pictures to `/accept`, a tapback to `/react`, an
edit or an unsend to `/edit`. It hands them to the gateway's `TexChat` object `chat:app:<userId>`, which runs the
texting Worker's `SenderInbox` exactly as every Photon chat in the gateway does (`texChat.js`). From there nothing is
new: node `text` (or `edit`), the queue, `/agent` with the texts client's session, the front door and everything the
config graph and a promoted Lab draft wire, the tools, the egress gate, `sendTheReply.js`. What Tex sends goes out
over the **app line** (`packages/tex/worker/appChat.ts` `appLine`), which texts nobody: the chat object logs each Tex text,
picture and tapback as an event, as it does for Photon, and the app reads them back. A "simplification" that calls
`/agent` straight from the route would skip the queue, the arrival steps, the edit node and the chat's own state, and
the app would answer differently from the texts; `test/appChat.test.mjs` fails if the route stops posting to the chat
object.

**Its own chat, the same history.** Every event the app chat writes goes into the person's one record (their `texts`
ledger, `agent/ledger.js` `ONE_TO_ONE_CHAT`), marked `via: "app"` (`eventEntry`). Tex's history reads the whole
record, so in the app Tex remembers the texts and on iMessage it remembers the app. The app shows only the entries
marked `via: "app"`, plus the chat object's unflushed outbox, merged by event id (`appChatRows.js`). Reversing the
mark would show the person's iMessage thread inside the app, which Dev2 rejected on the mockup.

**Pictures** are kept in the app chat's own object, by a random id, in pieces under a Durable Object's 2 MB value cap
(`packages/tex/worker/appPictures.ts`), JPEG, PNG, GIF or WebP only, the kind read from the bytes. The app shrinks a
picture before it goes. A turn reads one at `https://app-chat.invalid/pic/<id>`, a name no network resolves, which
only that chat object's own fetch answers (`texChat.js` `chatEnv` `FETCH`); Tex's own pictures are kept the same way
by the app line, and their address is the picture event's text. The app reads a picture through `op: "picture"`, as
the chat's owner, and only an id that chat's rows show; it is served with `nosniff` and a sandboxing CSP. A picture
the person takes back is deleted, every piece of it. A day holds at most 60 pictures a chat.

**Tapbacks, replies, edits and unsends** are Messages' own: the six tapbacks on any row, a reply with the replied-to
words quoted, and an edit or unsend of the person's own text within 15 minutes, named to the chat object by the
handle it kept for that text (`replyQuote.ts` `HANDLES_KEY`). The person's last tapback on a row is kept beside it
(`app:tap:<eventId>`), since a tapback's own event names its target only in words.

**Who.** Only the console's own client (`context_console`), on a personal workspace, as its owner. The chat is named
from the session's user id and nothing in the body names a chat, a user or a workspace; every row id in a body is
checked against that chat's rows. The turn's session is minted by the control plane at `/agent-texts/app-session`
(worker secret, the same trust as `/agent-texts/session`), for that user's personal workspace with the phone path's
own checks (texting not paused, a live member who may operate): the same `context_texts` grant, its audit row marked
`via: "app"`, and it starts no check-ins (they go out as texts). A turn runs as an app chat's user only in the object
the gateway placed for that chat (`APP_CHAT`, `reply.ts` `sessionOf`): an `app:` chat id arriving any other way, say
in a provider's webhook, names nobody. Every call but a read
counts against the chat's daily cap of 200.

**Approvals are the texted ones, drawn as one card** (Dev2, 2026-11-20, mock "in-app Tex"). An ask's row carries
`ask.card` (`agent/appChatCards.js`): an email's From, To, Subject and body, or any other held step's summary and copy,
built from the held record while it waits and from what the chat object kept (`app:card:<ask>`) after. The page draws
the card in place of the ask's words, never a tool name or its arguments. **Send** (`op: "answer"`, `choice: "send"`)
may carry the email's body as the person edited it in place: the gateway rewrites the body only (`tools/heldEdit.js`:
the person's own Tex 1:1 email, no forward, no attachment, no group's ask; who it goes to never changes here), arms
that one ask, and hands the chat object the same 👍 a person's tapback is, on the words of the ask as it now stands, so
the turn settles it with every check a texted yes has (`textedApprovals.js` `thumbsUpIsYes`). **Not now**
(`choice: "hold"`) only keeps the card as held: nothing is settled, run or started, and the ask stays as armed as it
was. A yes replied onto a card ("go ahead") arms that card's ask before the text goes in, so the draft the
person pointed at is the one their yes settles. The page names an ask's id and never runs a tool.

**Not yet** (later pull requests): the app chat's pictures in Download as folders and deleted with the account
(they live in the chat's object, not the workspace's files bucket: a call for the owner, against non-negotiable #1);
pruning the chat object's kept keys; files other than pictures, and voice; a background job's later report and
check-ins on the app line (they go to the Worker's object by name today); a socket in place of the poll; one chat
object for a person's phone and app, so a text and an app message never run as two turns at once.

## The turn leaves the chat object (Dev2, 2026-11-20)

An app chat is born in the gateway, and its chat object used to call `/agent` in-process (`texChat.js` `chatEnv`), so
the whole turn ran in the object's isolate. On 2026-11-20 at 13:26:06Z Dev2's "Daniel 6 notes" text ran the isolate out
of memory after the note was written and before the reply went, and nothing answered it. In-process app turns were
also slower: over the three days before, the app chat's turns took 34.8 s at the median against 16.8 s for texted ones,
with about the same model time. Dev2 chose the phone's route: the app chat's `POST /agent` goes over the network to
the gateway, a fresh isolate, as the texting Worker's does (`hopToGateway`); the smaller routes (`/agent/steer`,
`/agent/events`, ...) stay in-process. Only a hop that throws before any answer runs the turn in-process, so a text
is never dropped for want of the hop. Reverting it brings the memory reset back: `test/texChatAppHop.test.mjs` fails.
