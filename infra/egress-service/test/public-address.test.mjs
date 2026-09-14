import assert from "node:assert/strict";
import test from "node:test";

import { isPublicAddress } from "../container/public-address.mjs";

test("public IPv4 and IPv6 addresses are accepted", () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
});

test("private, local, reserved, and documentation IPv4 addresses are denied", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
  ]) assert.equal(isPublicAddress(address), false, address);
});

test("private, local, mapped, reserved, and documentation IPv6 forms are denied", () => {
  for (const address of [
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1",
    "64:ff9b:1::1", "100::1", "2001:db8::1", "4000::1", "fc00::1",
    "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1",
  ]) assert.equal(isPublicAddress(address), false, address);
});

test("malformed addresses and IPv6 zone identifiers fail closed", () => {
  for (const address of ["", "example.com", "999.1.1.1", "fe80::1%eth0", "[::1]"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});
