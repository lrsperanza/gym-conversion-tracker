import { describe, expect, test } from "bun:test";
import { redactSecrets, classifyFfmpegError } from "../src/ffmpeg.ts";

describe("redactSecrets", () => {
  const url =
    "rtsp://gymapi:p%40ss%2Fword@192.168.1.191:554/cam/playback?channel=1";
  const secrets = [url, "p@ss/word", "p%40ss%2Fword"];

  test("scrubs the full authenticated URL echoed by FFmpeg", () => {
    const line = `Input #0, rtsp, from '${url}':`;
    const out = redactSecrets(line, secrets);
    expect(out).not.toContain("p%40ss%2Fword");
    expect(out).not.toContain("p@ss/word");
    expect(out).toContain("Input #0, rtsp");
  });

  test("scrubs raw and encoded password forms", () => {
    const out = redactSecrets("auth failed for p@ss/word / p%40ss%2Fword", secrets);
    expect(out).toBe("auth failed for *** / ***");
  });

  test("leaves unrelated text untouched", () => {
    const line = "Duration: 00:05:00.00, start: 0.000000";
    expect(redactSecrets(line, secrets)).toBe(line);
  });

  test("ignores empty secrets", () => {
    expect(redactSecrets("hello", [""])).toBe("hello");
  });
});

describe("classifyFfmpegError", () => {
  test("401 maps to AUTH_FAILED", () => {
    expect(
      classifyFfmpegError("method DESCRIBE failed: 401 Unauthorized").code,
    ).toBe("AUTH_FAILED");
  });

  test("connection refused maps to DVR_UNREACHABLE", () => {
    expect(
      classifyFfmpegError("Connection refused by 192.168.1.191").code,
    ).toBe("DVR_UNREACHABLE");
  });

  test("timeout maps to RTSP_ERROR", () => {
    expect(
      classifyFfmpegError("Connection timed out after 15 seconds").code,
    ).toBe("RTSP_ERROR");
  });

  test("unknown failures map to RTSP_ERROR", () => {
    expect(classifyFfmpegError("Conversion failed!").code).toBe("RTSP_ERROR");
  });
});
