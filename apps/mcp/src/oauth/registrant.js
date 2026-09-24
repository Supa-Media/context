/**
 * Who is registering, as the registration rate limiter should count them.
 */

import { sha256Hex } from "../controlPlane.js";

/**
 * The network a registration came from, as the limiter should count it.
 *
 * **A key a stranger can rotate is a write amplification on a table nothing
 * sweeps**, which this repository has already argued once, at the ingestion
 * limiter: *"anyone able to send mail can mint an unbounded number of rows by
 * addressing a million invented names"*. An IPv6 host is routinely given a
 * whole `/64` — standard on a cheap VPS and on residential broadband — so
 * keying on the address would hand one customer 2^64 free buckets, and each
 * distinct bucket is its own permanent `rateLimits` row. Measured before this
 * function existed: 100 registrations from a rotating address produced 100
 * client rows **and** 100 limiter rows, where an unlimited endpoint produced
 * 100. The limit made the growth worse.
 *
 * So an IPv6 address counts as its /64 and an IPv4 address counts as itself.
 * That collapses the cheap keyspace to one bucket per network. It does not
 * make the keyspace *bounded* — somebody holding many networks still holds
 * many buckets — which is why the sweep in `crons.ts` is the other half of
 * this and not an optimisation.
 *
 * Normalising also fixes three ways of writing one host that were three
 * buckets: `2001:db8::1`, its expanded form, and its upper-case form; and
 * `::ffff:203.0.113.7` against `203.0.113.7`.
 *
 * Returns `null` for anything it cannot parse, which the caller treats exactly
 * as a missing header — shared, never unlimited.
 */
function ipv4(candidate) {
  /*
    ONE HOST, ONE SPELLING. `\d+` per octet accepts unbounded leading zeros, so
    `203.000.113.007` and `00000000203.0.113.7` were a second and a third
    bucket for one address — the same rotation the /64 work closes, through the
    door that had not been normalised. One to three digits, no leading zero
    unless the octet is zero, and at most 255.
  */
  const parts = candidate.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255 ? Number(part) : null
  );
  return octets.some((octet) => octet === null) ? null : octets.join(".");
}

/** The two hextets a dotted quad occupies, for rejoining a /64. */
function quadAsHextets(quad) {
  const [a, b, c, d] = quad.split(".").map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

export function registrantNetwork(rawAddress) {
  const address = String(rawAddress ?? "").trim().toLowerCase();
  if (address === "") return null;

  // `[2001:db8::1]:443` and `203.0.113.7:443`. A header should not carry a
  // port, and one that does must not be a second bucket for the same host.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  const bare = bracketed ? bracketed[1] : address.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");

  if (!bare.includes(":")) return ipv4(bare);

  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const [head, tail] = halves;
  const left = head === "" ? [] : head.split(":");
  const right = halves.length === 2 ? (tail === "" ? [] : tail.split(":")) : [];

  /*
    EXPANDED TO EIGHT HEXTETS BEFORE ANYTHING IS DECIDED.

    A trailing dotted quad occupies the last two hextets, and the previous
    version classified from the TEXT — "does the last group contain a dot" —
    which split one address into two buckets: `::ffff:203.0.113.7` was the IPv4
    host and `::ffff:cb00:7107`, the same address, was `0:0:0:0::/64`. Expand
    first, decide from the numbers, and the two spellings cannot disagree.
  */
  const hextetsOf = (groups, quadMayEndIt) => {
    const out = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (quadMayEndIt && index === groups.length - 1 && group.includes(".")) {
        const quad = ipv4(group);
        if (quad === null) return null;
        out.push(...quadAsHextets(quad));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(group);
    }
    return out;
  };
  const leftHextets = hextetsOf(left, halves.length === 1);
  const rightHextets = hextetsOf(right, halves.length === 2);
  if (leftHextets === null || rightHextets === null) return null;

  let filled;
  if (halves.length === 2) {
    /*
      `::` STANDS FOR AT LEAST ONE ZERO GROUP, so an address that already has
      eight has no room for it. Refused rather than clamped, and this is the
      line whose absence made `Array(8 - left - right)` go negative and throw
      `RangeError` — which escaped as a 503 for an address the docblock
      promises answers `null`.
    */
    if (leftHextets.length + rightHextets.length >= 8) return null;
    filled = [
      ...leftHextets,
      ...Array(8 - leftHextets.length - rightHextets.length).fill("0"),
      ...rightHextets,
    ];
  } else {
    if (leftHextets.length !== 8) return null;
    filled = leftHextets;
  }

  const numeric = filled.map((part) => parseInt(part, 16));

  /*
    ONLY `::ffff:0:0/96` NAMES AN IPv4 HOST.

    The IPv4-COMPATIBLE form `::a.b.c.d` is deprecated by RFC 4291 and is NOT
    read as one, which is a deliberate change: it is the same address as
    `::cb00:7107`, and reading it as a host would make `::1` mean host
    `0.0.0.1`. It stays an ordinary address inside `::/64`.

    `64:ff9b::/96` (NAT64) and `::ffff:0:0:0/96` (SIIT) embed the address being
    translated TO — a destination, never the source that arrived here — so
    crediting them to that host would let a translator spend a stranger's
    budget.
  */
  if (numeric.slice(0, 5).every((part) => part === 0) && numeric[5] === 0xffff) {
    return [numeric[6] >> 8, numeric[6] & 0xff, numeric[7] >> 8, numeric[7] & 0xff].join(".");
  }

  return `${numeric.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

/**
 * A stable, non-identifying bucket name for whoever is registering.
 *
 * `undefined` when Cloudflare did not set a header this can read, which the
 * control plane treats as "share the unattributed bucket" rather than as "no
 * limit" — see the comment at the call site for why that direction is the only
 * safe one.
 */
export async function registrantKey(request) {
  const network = registrantNetwork(request.headers.get("CF-Connecting-IP"));
  if (network === null) return undefined;
  return (await sha256Hex(network)).slice(0, 32);
}
