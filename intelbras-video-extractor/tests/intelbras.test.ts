import { describe, expect, test } from "bun:test";
import {
  toIntelbrasChannel,
  buildPlaybackUrl,
  parseDigestChallenge,
  buildDigestAuthorization,
} from "../src/intelbras.ts";
import { parseCameraIndex } from "../src/cli.ts";
import { ExtractorError } from "../src/errors.ts";

describe("toIntelbrasChannel (zero-based -> one-based)", () => {
  test("maps 0 -> 1", () => {
    expect(toIntelbrasChannel(0)).toBe(1);
  });

  test("maps 1 -> 2", () => {
    expect(toIntelbrasChannel(1)).toBe(2);
  });

  test("maps 7 -> 8", () => {
    expect(toIntelbrasChannel(7)).toBe(8);
  });

  test("rejects -1", () => {
    expect(() => toIntelbrasChannel(-1)).toThrow(ExtractorError);
  });

  test("rejects 1.5", () => {
    expect(() => toIntelbrasChannel(1.5)).toThrow(ExtractorError);
  });

  test("rejects NaN", () => {
    expect(() => toIntelbrasChannel(NaN)).toThrow(ExtractorError);
  });
});

describe("parseCameraIndex (CLI string parsing)", () => {
  test("parses valid indexes", () => {
    expect(parseCameraIndex("0")).toBe(0);
    expect(parseCameraIndex(" 3 ")).toBe(3);
  });

  test("rejects negative, fractional and non-numeric input", () => {
    for (const bad of ["-1", "1.5", "abc", "", "0x2"]) {
      expect(() => parseCameraIndex(bad)).toThrow(ExtractorError);
    }
  });
});

describe("buildPlaybackUrl", () => {
  const base = {
    host: "192.168.1.191",
    port: 554,
    channel: 1,
    user: "admin",
    password: "s3cret",
    startDvr: "2026_08_24_09_30_00",
    endDvr: "2026_08_24_09_35_00",
  };

  test("contains channel, starttime, endtime, host and port", () => {
    const { url } = buildPlaybackUrl(base);
    expect(url).toContain("rtsp://");
    expect(url).toContain("@192.168.1.191:554");
    expect(url).toContain("/cam/playback?");
    expect(url).toContain("channel=1");
    expect(url).toContain("starttime=2026_08_24_09_30_00");
    expect(url).toContain("endtime=2026_08_24_09_35_00");
  });

  test("percent-encodes special characters in credentials", () => {
    const { url } = buildPlaybackUrl({
      ...base,
      user: "adm in",
      password: "p@ss/word:1",
    });
    expect(url).toContain("adm%20in:p%40ss%2Fword%3A1@");
    expect(url).not.toContain("p@ss");
  });

  test("redacted URL never contains the password", () => {
    const { url, redacted } = buildPlaybackUrl(base);
    expect(url).toContain("s3cret");
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toContain("admin:***@192.168.1.191:554");
    expect(redacted).toContain("channel=1");
    expect(redacted).toContain("starttime=2026_08_24_09_30_00");
    expect(redacted).toContain("endtime=2026_08_24_09_35_00");
  });

  test("redacted URL hides even percent-encoded special passwords", () => {
    const { redacted } = buildPlaybackUrl({
      ...base,
      password: "p@ss/word",
    });
    expect(redacted).not.toContain("p%40ss");
    expect(redacted).not.toContain("p@ss");
  });
});

describe("HTTP Digest helpers", () => {
  test("parses a Digest challenge header", () => {
    const params = parseDigestChallenge(
      'Digest realm="DVR", nonce="abc123", qop="auth", algorithm=MD5',
    );
    expect(params).not.toBeNull();
    expect(params!.realm).toBe("DVR");
    expect(params!.nonce).toBe("abc123");
    expect(params!.qop).toBe("auth");
  });

  test("rejects non-Digest challenges", () => {
    expect(parseDigestChallenge("Basic realm=\"x\"")).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
  });

  test("builds an Authorization header without leaking the password verbatim", () => {
    const challenge = parseDigestChallenge(
      'Digest realm="DVR", nonce="abc123", qop="auth"',
    )!;
    const header = buildDigestAuthorization({
      username: "admin",
      password: "s3cret",
      method: "GET",
      uri: "/cgi-bin/magicBox.cgi?action=getDeviceType",
      challenge,
    });
    expect(header).not.toBeNull();
    expect(header).toMatch(/^Digest /);
    expect(header).toContain('username="admin"');
    expect(header).toContain('realm="DVR"');
    expect(header).toContain('nonce="abc123"');
    expect(header).toContain("qop=auth");
    expect(header).toMatch(/response="[0-9a-f]{32}"/);
    expect(header).not.toContain("s3cret");
  });
});
