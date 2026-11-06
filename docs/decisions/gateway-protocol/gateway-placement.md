# Gateway protocol: the gateway runs beside its workspace objects

**Decided by the owner, 2026-11-04**, for Dev's "every read and write under
0.1 s".

### Why

The workspace objects run in the eastern US (location hint `enam`). The gateway
ran at the edge nearest whoever called it. Every trip from the gateway to an
object therefore cost 25 to 60 ms (`obj:*` points in `mcp_entry`, at every
data center that served fetch, 2026-11-03). A plain note read makes about four
dependent trips: session, open, row lookup, read. That put it at about 175 ms
even after it was cut down to one read call
([note-read-in-object](./note-read-in-object.md)). Orient, search and writes
make more.

### The rule

`apps/mcp/wrangler.toml` sets a placement hint, `[placement] region =
"aws:us-east-1"`, so Cloudflare runs the gateway in the data center nearest
that region. Staging inherits it. The caller pays one longer hop in; every
object trip after that takes a few milliseconds. Convex's cloud, the control plane,
runs in that region by default, so its calls should get shorter too.

### What it must not become

- **Overridden per environment, or dropped.** No other test would fail, and
  every object trip would go back to 25 to 60 ms. Test:
  `apps/mcp/test/gatewayPlacement.test.mjs`.
- **A second region for the objects.** If workspace objects ever move, this
  hint moves with them.
