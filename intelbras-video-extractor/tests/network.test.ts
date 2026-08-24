import { describe, expect, test } from "bun:test";
import {
  ipInCidr,
  ipv4ToInt,
  isTailscaleInterfaceName,
} from "../src/network.ts";

const GYM = "192.168.1.0/24";

describe("ipInCidr", () => {
  test("address inside the gym LAN is LAN", () => {
    expect(ipInCidr("192.168.1.45", GYM)).toBe(true);
  });

  test("the DVR itself is inside the gym LAN", () => {
    expect(ipInCidr("192.168.1.191", GYM)).toBe(true);
  });

  test("adjacent network is not the gym LAN", () => {
    expect(ipInCidr("192.168.2.45", GYM)).toBe(false);
  });

  test("Tailscale 100.x address is not the gym LAN", () => {
    expect(ipInCidr("100.100.1.5", GYM)).toBe(false);
  });

  test("network boundary addresses", () => {
    expect(ipInCidr("192.168.1.0", GYM)).toBe(true);
    expect(ipInCidr("192.168.1.255", GYM)).toBe(true);
    expect(ipInCidr("192.168.0.255", GYM)).toBe(false);
  });

  test("rejects malformed input", () => {
    expect(ipInCidr("999.1.1.1", GYM)).toBe(false);
    expect(ipInCidr("192.168.1", GYM)).toBe(false);
    expect(ipInCidr("192.168.1.45", "not-a-cidr")).toBe(false);
  });
});

describe("ipv4ToInt", () => {
  test("converts dotted quad", () => {
    expect(ipv4ToInt("192.168.1.191")).toBe(0xc0a801bf);
  });

  test("rejects invalid addresses", () => {
    expect(ipv4ToInt("256.1.1.1")).toBeNull();
    expect(ipv4ToInt("abc")).toBeNull();
  });
});

describe("isTailscaleInterfaceName", () => {
  test("matches common Tailscale interface names", () => {
    expect(isTailscaleInterfaceName("tailscale0")).toBe(true);
    expect(isTailscaleInterfaceName("Tailscale")).toBe(true);
  });

  test("does not match ordinary interfaces", () => {
    expect(isTailscaleInterfaceName("Ethernet")).toBe(false);
    expect(isTailscaleInterfaceName("Wi-Fi")).toBe(false);
  });
});
