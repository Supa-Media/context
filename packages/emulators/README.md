# @context/emulators

Stand-ins for the outside APIs Context calls, kept in one place, so a pull
request preview (and any test) can exercise Gmail, Calendar, Google sign-in,
Resend and the rest **before** a change merges, without a real account.

An emulator is a small stateful server with the real API's paths and response
shapes, not a mock that returns canned answers: an event a test adds is there
on the next list, a token it was issued is refused once revoked.

## Where emulators come from

| Source | Folder / package | Today |
| --- | --- | --- |
| [Vercel Labs' emulate](https://github.com/vercel-labs/emulate) (Apache-2.0) | `@emulators/<name>` from npm | `google` (OAuth/OpenID, Gmail, Calendar, Drive), `resend` |
| Our own | `src/own/<name>/` | none yet (next: Google Chat, Calendar sync tokens and push) |
| Elsewhere | named in its `source` | none yet |

[`src/services.mjs`](./src/services.mjs) is the one list: each entry names its
source, how to load it, and which real hosts it stands in for. Adding an
emulator is one entry there plus its test. An own emulator uses the same
plugin shape emulate's `@emulators/*` packages export, so they all mount the
same way.

## Using it

- **In a test:** `createEmulators()` returns a fetch handler serving every
  emulator at `/<service>/...`; `emulatedUrl(realUrl, origin)` rewrites a real
  API URL (`https://www.googleapis.com/calendar/v3/...`) to the emulator's.
  A URL no emulator covers maps to `null`, and the caller must refuse it.
- **In a preview:** `src/worker.mjs` is the Worker a preview deploys as
  `context-emulators-pr<N>`, state in one Durable Object. There is no staging
  or production copy.
- **Locally:** `pnpm --filter @context/emulators dev`.

The starting state ([`src/seed.mjs`](./src/seed.mjs)) is one Google account per
preview persona (`alpha@supa.media` ... `epsilon@supa.media`), each with a
primary calendar and a welcome email. Add what a check needs through the real
APIs: sign in at `/google/o/oauth2/v2/auth`, then Calendar `events.insert`
(attendees with `responseStatus`), Gmail `messages.import`.

## Known gaps in emulate's Google

Calendar has list, insert, delete and freeBusy, but no `events.get`/`patch`,
no `syncToken`/`nextSyncToken`, and no `watch` push. There is no Google Chat,
People or Maps. These go upstream to emulate first, or into `src/own/`.

## Running in a Worker

emulate is written for Node. Two settings in `wrangler.jsonc` make it run on
Workers (`nodejs_compat`): `fs` is aliased to [`src/fs-shim.mjs`](./src/fs-shim.mjs)
because the sign-in pages read fonts from disk at load, and `import.meta.url`
is defined because a bundle has none. `pnpm bundle` proves it still bundles.
