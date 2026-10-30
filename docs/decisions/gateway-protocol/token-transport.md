# URL tokens are counted, then retired route by route

Decided 2026-10-28 (CASA round 2, token-in-URL finding).

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
3. **Retire per route, on evidence.** A route's URL form is refused only after
   its census reads zero outside-client grants for 30 days and the console
   count has drained as old app builds age out. That date is the owner's call,
   made with the census in hand. It is not a fixed date written here.

What a simplification would cost: refusing `/t/` outright breaks every
connection that still uses it, unmeasured; counting by logging the path would
put tokens or note paths in logs. `apps/mcp/test/tokenTransport.test.mjs`,
the presence route checks and `apps/convex/__tests__/controlPlane/tokenTransport.test.ts`
fail if a header token is counted, a route is recorded as anything but its
coarse name, the subprotocol answer echoes the token, or a revoked grant is
counted.
