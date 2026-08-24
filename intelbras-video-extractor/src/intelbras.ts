import { createHash, randomBytes } from "node:crypto";
import { ExtractorError } from "./errors.ts";
import type { Config } from "./config.ts";

/** CLI camera indexes are zero-based; Intelbras channels are one-based. */
export function toIntelbrasChannel(cameraIndex: number): number {
  if (!Number.isInteger(cameraIndex) || cameraIndex < 0) {
    throw new ExtractorError(
      "INVALID_CAMERA",
      `Invalid camera index "${cameraIndex}": expected a zero-based non-negative integer.`,
    );
  }
  return cameraIndex + 1;
}

export type PlaybackUrl = {
  /** Authenticated URL handed to FFmpeg. Never log this. */
  url: string;
  /** Same URL with the password redacted — safe for logs. */
  redacted: string;
};

export function buildPlaybackUrl(opts: {
  host: string;
  port: number;
  channel: number;
  user: string;
  password: string;
  startDvr: string;
  endDvr: string;
}): PlaybackUrl {
  // Credentials are percent-encoded (never concatenated into a shell command).
  // If a given DVR firmware rejects percent-encoded credentials, that is a
  // device limitation — use credentials without reserved characters.
  const user = encodeURIComponent(opts.user);
  const password = encodeURIComponent(opts.password);
  const query =
    `channel=${opts.channel}` +
    `&starttime=${opts.startDvr}` +
    `&endtime=${opts.endDvr}`;
  const base = `${opts.host}:${opts.port}/cam/playback?${query}`;
  return {
    url: `rtsp://${user}:${password}@${base}`,
    redacted: `rtsp://${user}:***@${base}`,
  };
}

// ---------------------------------------------------------------------------
// Optional HTTP Digest preflight (magicBox.cgi)
// ---------------------------------------------------------------------------

export type PreflightResult = "ok" | "auth_failed" | "unsupported" | "unreachable";

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

function quoteDigestValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function parseDigestChallenge(
  header: string | null,
): Record<string, string> | null {
  if (!header || !/^Digest\s/i.test(header.trim())) return null;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return params;
}

export function buildDigestAuthorization(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: Record<string, string>;
}): string | null {
  const realm = opts.challenge["realm"];
  const nonce = opts.challenge["nonce"];
  if (!realm || !nonce) return null;

  const qopOptions = (opts.challenge["qop"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const qop = qopOptions.includes("auth") ? "auth" : undefined;

  const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
  const ha2 = md5(`${opts.method}:${opts.uri}`);

  let response: string;
  let suffix = "";
  if (qop) {
    const nc = "00000001";
    const cnonce = randomBytes(8).toString("hex");
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    suffix = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  return (
    `Digest username="${quoteDigestValue(opts.username)}", ` +
    `realm="${quoteDigestValue(realm)}", nonce="${quoteDigestValue(nonce)}", ` +
    `uri="${quoteDigestValue(opts.uri)}", response="${response}"${suffix}`
  );
}

/**
 * Best-effort credential check against the Intelbras HTTP API (Digest auth).
 * Used only to distinguish "wrong credentials" from "network problem" early.
 * Anything other than a definitive answer never blocks the RTSP download.
 */
export async function checkHttpCredentials(cfg: Config): Promise<PreflightResult> {
  const uri = "/cgi-bin/magicBox.cgi?action=getDeviceType";
  const base = `http://${cfg.dvrHost}:${cfg.httpPort}`;

  let challengeHeader: string | null;
  try {
    const first = await fetch(base + uri, { signal: AbortSignal.timeout(5000) });
    if (first.status === 200) return "ok";
    if (first.status !== 401) return "unsupported";
    challengeHeader = first.headers.get("www-authenticate");
  } catch {
    return "unreachable";
  }

  const challenge = parseDigestChallenge(challengeHeader);
  if (!challenge) return "unsupported";

  const authorization = buildDigestAuthorization({
    username: cfg.user,
    password: cfg.password,
    method: "GET",
    uri,
    challenge,
  });
  if (!authorization) return "unsupported";

  try {
    const second = await fetch(base + uri, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (second.status === 200) return "ok";
    if (second.status === 401) return "auth_failed";
    return "unsupported";
  } catch {
    return "unreachable";
  }
}
