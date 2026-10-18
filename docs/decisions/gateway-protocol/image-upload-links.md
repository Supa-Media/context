# Gateway protocol: upload links for images

## An agent with a picture as a file sends it with a one-use upload link

`write_note`'s `images` took base64 or an https URL
([agent-images](./agent-images.md)). Base64 makes the model read the whole
picture out as text, which a real screenshot makes too long to send; a URL
needs the picture to be public somewhere first. An agent with a shell (Claude
Code, Codex) has the file on disk and can run `curl`, and was pushing pictures
to a temporary GitHub branch to get a URL. That was the gap (owner,
2026-10-15: "why are you able to push to a github branch but not context").

So, still one tool, now an action in `write`'s `args`
([six tools that never change](./six-tools.md)); the rule it came from is
[a new argument reaches a client that a new tool cannot](../gateway-protocol.md):

1. `write_note` with `upload: [{ name, sha256, bytes }]` and no content mints
   one ticket per picture and answers with a `curl` line for each. Nothing is
   written.
2. The agent runs it: `PUT /api/image-upload`, the ticket in
   `Authorization: Bearer`, the file as the body. The gateway measures the
   body, sniffs its type, hashes it, and spends the ticket for that hash.
3. `write_note` with `images: [{ name, sha256 }]` embeds it, exactly as an
   attached picture: a content-hashed leaf in the opaque image store, the
   same embed rewrite, the note's visibility.

**A looked-up name is the whole hash.** A picture attached in the call is
stored under the first sixteen hex characters of its SHA-256, which is enough
for the only thing that name decides there — dedupe — and is what notes
already written point at. A picture sent through a link is different: its
name is later *asked for* by hash, and a sixteen-character name answers a
caller naming sixty-four about something agreeing with only its first 64
bits. So a link stores under the whole hash, and finding one is the check:
there is nothing to compare and no body to read. The cost is one duplicate
object when the same picture arrives both ways.

**The ticket is a capability for one set of bytes, not a credential.** It is a
`gatewayJobs` row of kind `image_upload`, minted only through a live grant
with writer clearance (owner or editor, `context:write`), the same two proofs
every gateway route spends. It opens that one context's bucket once, within
ten minutes, for exactly the SHA-256 and length the agent declared, and at
open time the control plane re-checks that the grant is live and the person
can still write there. Opened with any other bytes it opens nothing and stays
unspent, so somebody who learns it can store the picture the agent was about
to store, unreferenced, and nothing else. It travels in a header, never the
URL, so "credentials never live in URLs" holds even for this. Spent and
unspent tickets are swept after ten minutes; they are tickets, not history.

**What was rejected.** An HMAC-signed URL minted by the gateway alone: the
gateway cannot open a bucket without a person's token
(`/gateway/binding` is two-factor by design), so it would have needed a
control-plane door that opens a binding by workspace id, which is the door the
control plane exists to not have. A scratch bucket of ours to hold bytes until
`write_note` collects them: a copy of customer data outside the customer's
bucket. A separate table: the job row already carries the open path
(binding, managed encryption) the store needs; the price is that move-only
readers of `gatewayJobs` (the Settings moves card, the privacy authority's
leased-move proof) filter on `kind`, and a test proves an upload is never
read as a move.

**What fails if this is reversed.** `apps/convex/__tests__/controlPlane/imageUploadJobs.test.ts`
(other bytes, revocation, demotion, expiry, a member, another workspace, never
a move) and `apps/mcp/test/imageUploadLinks.test.mjs` (the whole road, a ticket
used twice, other bytes, SVG, oversize, a revoked grant, a read-only
connection, shell quoting, a hash never uploaded here).
