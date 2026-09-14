import { isIP } from "node:net";

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function ipv6Number(address) {
  if (typeof address !== "string" || address.includes("%") || isIP(address) !== 6) return null;
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const v4 = ipv4Number(source.slice(lastColon + 1));
    if (v4 === null) return null;
    source = `${source.slice(0, lastColon)}:${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inCidr(value, base, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

const DENIED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([address, prefix]) => [ipv4Number(address), prefix]);

const DENIED_V6 = [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
].map(([address, prefix]) => [ipv6Number(address), prefix]);

/** True only for an IP address that is globally routable, never for a hostname. */
export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    return !DENIED_V4.some(([base, prefix]) => inCidr(value, base, prefix, 32));
  }
  if (version === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    // IANA currently allocates global unicast from 2000::/3. Everything else
    // is reserved, local, multicast, translation space, or future space; a
    // public-only proxy may conservatively refuse future allocations until its
    // registry is reviewed rather than guessing that "not private" is public.
    const globalUnicast = ipv6Number("2000::");
    if (!inCidr(value, globalUnicast, 3, 128)) return false;
    return !DENIED_V6.some(([base, prefix]) => inCidr(value, base, prefix, 128));
  }
  return false;
}
