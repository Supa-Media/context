# URL tokens are counted, then retired route by route

Decided 2026-10-28 (CASA round 2, token-in-URL finding). **Retired on every
route but the live sockets by the owner, 2026-11-05** (below).

The gateway takes an access token two ways: an `Authorization: Bearer`
header, or `/t/<token>/...` in the path for a client that cannot set one. Both
resolve the same grant with the same authority, and the URL form was never the
security boundary. But a URL is kept by browser history, proxies and
referrers, so the URL form is on its way out. Refusing it today would cut off
whoever still depends on it without anyone knowing who that is. So:

1. **Count first.** When a token comes in the path, the gateway tells
   `/gateway/session` so, with a coarse route name (`mcp`, `agent`, `inbox`,
   `collaboration`, `presence`, `agent-activity`, `other`), and nothing else
   about the request (`apps/mcp/src/http/presentedToken.js`). The control
   plane stamps the grant, at most hourly per route, with `pathTokenSeenAt`
   and `pathTokenRoute`. `tokenTransport:pathTokenCensus` counts live grants
   by route, and splits the app's own console grant from outside clients. It
   names no grant, person, workspace or token. A header token sends nothing.
2. **Take our own app off it.** The app's presence socket was the main
   first-party user: a browser `WebSocket` cannot set a header. It now offers
   two subprotocols, `context.presence` and `context.token.<token>`, so the
   token travels in the `Sec-WebSocket-Protocol` request header. The gateway
   answers with `context.presence` alone, so the token is never echoed, and a
   token offered without `context.presence` is not read. Builds from before
   this still use the path form and still work.
3. **Then no token on a socket at all** (decided by the owner, 2026-11-05,
   for CASA). A subprotocol is still a request header that a proxy or a
   handshake log can keep, and the console token in it is reusable. The app's
   sockets (presence, the tree, access, the Tex page) now trade the token, in
   an `Authorization` header, for a ticket at `POST /presence/ticket`, naming
   the one socket it opens, and offer `context.ticket.<ticket>` instead
   (`apps/mcp/src/live/ticket.js`). A ticket is the token sealed with AES-GCM
   under a key derived from `GATEWAY_SECRET`, bound to that socket path and
   workspace selector, good for one minute and spent once: its nonce is
   marked in a `LiveTicket` Durable Object of its own, deleted by an alarm
   after it expires. The socket resolves the token inside exactly as before,
   so revocation and every clamp are unchanged, and a ticket that does not
   open is refused, never passed over for a token offered beside it. The
   `context.token.<token>` subprotocol is accepted only until the app builds
   that send it have rolled over, then removed.
4. **Retire per route, on evidence.** A route's URL form is refused only after
   its census reads zero outside-client grants for 30 days and the console
   count has drained as old app builds age out. That date is the owner's call,
   made with the census in hand. It is not a fixed date written here.
5. **Retired, 2026-11-05.** The owner retired the URL form: nobody uses it
   and it predates OAuth. `route.js` answers `/t/...` and `/@slug/t/...`
   with one fixed `410` that names the header, before the origin check and
   before any session is resolved, so the token is never looked up or sent to
   the control plane, valid or not. The one exception, for now, is the live
   sockets (`LIVE_SOCKET_PATHS`: presence, tree, access, agent activity, the
   Tex page), where older app builds still put the token in the path; that
   form is still counted and is retired separately.

What a simplification would cost: a ticket that is only signed (no spent
mark) can be replayed for its whole minute; a ticket not bound to its socket
opens any of them; refusing `/t/` outright breaks every
connection that still uses it, unmeasured; counting by logging the path would
put tokens or note paths in logs. `apps/mcp/test/tokenTransport.test.mjs` (which also fails if any `/t/` path but a live socket reaches a session, or the refusal varies with the token),
`apps/mcp/test/liveTicket.test.mjs` (spent, expired, forged, wrong-socket and wrong-selector tickets refused),
the presence route checks and `apps/convex/__tests__/controlPlane/tokenTransport.test.ts`
fail if a header token is counted, a route is recorded as anything but its
coarse name, the subprotocol answer echoes the token, or a revoked grant is
counted.
