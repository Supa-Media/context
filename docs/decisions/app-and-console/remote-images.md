# App and console: a remote image in a note

## A remote image is drawn through our proxy, never by the reader's browser

Until this, `![alt](https://…)` in a note drew as "Not in this bucket". A remote
image drawn straight into the page is a tracking pixel: its host sees every
read, with the reader's IP address, device and the time, and whoever can write
a note (a teammate, an agent filing an email) can plant one to learn when and
where a note is opened. Private notes would also announce to that host that
they exist and are being read.

The owner asked for the middle ground Notion uses (2026-09-26): an image proxy.
The editor's image loader sends an `https://` target to `files.readRemoteImage`
instead of `readNoteImage`; the server fetches the image and hands back bytes,
which the client draws as a `data:` URL exactly like a stored image. The host
sees one request from our servers, with no cookie, no referrer and nothing
about who asked.

- **The reference is the gate, as for a stored image.** The caller names a
  note, it is read through the `read` operation so `canSee` answers once, and
  the URL must appear in it. Anything else is `FILE_NOT_FOUND`, identical to a
  note that does not exist, and nothing is fetched. That is what stops this
  being an open proxy, and it is also why a member cannot use a private note's
  URL.
- **One fetch rule, shared with the gateway.** `packages/shared/src/remoteImage.cjs`
  is used here and by `write_note`'s `images[].url`: https, default port, no
  userinfo, a hostname rather than an IP literal, no `localhost`, at most
  three redirects each re-checked, 5 MB streamed with a hard stop. The bytes
  decide the type, never the remote `content-type`, so an SVG or a page served
  as `image/png` is refused.
- **Nothing is cached on the server.** An image kept by the control plane would
  be note content held outside the customer's bucket (non-negotiable #1). The
  client keeps what it drew for the session, so the host sees roughly one fetch
  per viewer per session, never who.
- **What it still does not do, stated.** The image is not in the bucket, so it
  does not leave with an export and breaks if the host deletes it; attaching it
  (`write_note` images, or a paste) is how to keep it. The anonymous share
  viewer (`share/markdown.ts`) and published websites still fetch nothing and
  show alt text, because their readers have no account the proxy could gate
  on. Plain `http://` images are not proxied.

**What a simplification of this costs.** Drawing the URL directly brings the
tracking pixel back. Dropping the reference gate makes this a proxy any member
can aim anywhere. Caching server-side puts customer content in our storage.

The checks are `apps/convex/__tests__/files/remoteImage.test.ts`.
