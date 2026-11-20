# Tex's computer

One Linux container per person or group chat, each behind its own Durable Object, so
a background job can run a command and keep files while it works. Dev2 picked
Cloudflare Sandbox (Containers) on 2026-11-20; the reasoning is in
`docs/decisions/texting-assistant/computer.md`.

- Reached only through the gateway's `TEX_COMPUTER` service binding: no route, no
  workers.dev address, no secret.
- `POST /computer/{run,read,write,list,stop}` with `{ owner, ... }`. `owner` is
  the 64-hex tag the gateway makes from a person's or chat's id
  (`packages/tex/gateway/agent/browserProviders.js`); it names nobody.
- The container starts with no internet and runs everything as an unprivileged
  user inside `/work`. It sleeps, and its disk is wiped, after ten idle minutes.
- `pnpm test` runs the route checks (vitest) and the container server against a
  temporary folder (`node --test`).
