import type { Subprocess } from "bun";
import { ExtractorError, type ErrorCode } from "./errors.ts";

let activeFfmpeg: Subprocess | null = null;

export function killActiveFfmpeg(): void {
  try {
    activeFfmpeg?.kill();
  } catch {
    // already gone
  }
}

export async function ensureFfmpegTools(): Promise<void> {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    let ok = false;
    try {
      const proc = Bun.spawnSync([tool, "-version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      ok = proc.exitCode === 0;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new ExtractorError(
        "FFMPEG_NOT_FOUND",
        `"${tool}" was not found on PATH.\n\n` +
          "FFmpeg is required (the script remuxes the RTSP stream; it does not " +
          "implement RTSP decoding itself). Install FFmpeg and make sure both " +
          "`ffmpeg` and `ffprobe` are on PATH, e.g. `winget install ffmpeg` " +
          "or download from https://www.gyan.dev/ffmpeg/builds/ on Windows, " +
          "`sudo apt install ffmpeg` on Debian/Ubuntu, `brew install ffmpeg` on macOS.",
      );
    }
  }
}

async function* streamLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export function classifyFfmpegError(stderr: string): {
  code: ErrorCode;
  message: string;
} {
  const s = stderr.toLowerCase();
  if (/401|unauthorized|authorization required|authentication/.test(s)) {
    return {
      code: "AUTH_FAILED",
      message:
        "The DVR rejected the credentials. INTELBRAS_USER / INTELBRAS_PASSWORD " +
        "must be the LOCAL DVR/NVR credentials, not the Intelbras/iSIC cloud account.",
    };
  }
  if (/connection refused|no route to host|network is unreachable/.test(s)) {
    return {
      code: "DVR_UNREACHABLE",
      message:
        "The DVR actively refused the connection or the network route " +
        "disappeared mid-transfer.",
    };
  }
  if (/timed?\s*out|timeout/.test(s)) {
    return {
      code: "RTSP_ERROR",
      message: "Timed out waiting for the DVR RTSP playback stream.",
    };
  }
  if (/404|not found|no stream|invalid data found/.test(s)) {
    return {
      code: "NO_RECORDING",
      message:
        "The DVR reported no recording for the requested interval/channel " +
        "(or the channel number is invalid for this device).",
    };
  }
  return {
    code: "RTSP_ERROR",
    message: "FFmpeg failed to retrieve the recording from the DVR.",
  };
}

export type DownloadOptions = {
  /** Authenticated RTSP URL (never logged). */
  url: string;
  /** Redacted URL, safe for verbose logs. */
  redactedUrl: string;
  /**
   * Strings that must never appear in logs (raw password, its percent-encoded
   * form, the full authenticated URL). FFmpeg echoes the input URL in its
   * stderr ("Input #0, rtsp, from '...'"), so every captured line is scrubbed.
   */
  secrets: string[];
  durationSeconds: number;
  outputPath: string;
  verbose: boolean;
  onProgress?: (pct: number) => void;
};

const STALL_TIMEOUT_MS = 30_000;

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

type AttemptResult = {
  exitCode: number;
  stderrTail: string;
  killReason: string | null;
};

async function spawnAttempt(
  argv: string[],
  opts: DownloadOptions,
): Promise<AttemptResult> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  activeFfmpeg = proc;

  const startedAt = Date.now();
  let lastActivity = startedAt;
  // The overall timeout scales with the requested clip duration: a 30-minute
  // clip legitimately takes much longer than a 10-second one.
  const overallTimeoutMs = Math.max(
    180_000,
    opts.durationSeconds * 3000 + 120_000,
  );
  let killReason: string | null = null;

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > STALL_TIMEOUT_MS) {
      killReason =
        `No data received from the DVR for ${STALL_TIMEOUT_MS / 1000}s — ` +
        "the RTSP playback stream stalled.";
      try {
        proc.kill();
      } catch {
        // already exited
      }
    } else if (now - startedAt > overallTimeoutMs) {
      killReason =
        `Exceeded the overall retrieval timeout of ` +
        `${Math.round(overallTimeoutMs / 1000)}s for a ` +
        `${Math.round(opts.durationSeconds)}s clip.`;
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }
  }, 1000);

  let stderrTail = "";
  const readStderr = (async () => {
    for await (const line of streamLines(proc.stderr as ReadableStream<Uint8Array>)) {
      lastActivity = Date.now();
      const safe = redactSecrets(line, opts.secrets);
      stderrTail = (stderrTail + safe + "\n").slice(-12_000);
      if (opts.verbose) console.error(`[ffmpeg] ${safe}`);
    }
  })();

  const readStdout = (async () => {
    for await (const line of streamLines(proc.stdout as ReadableStream<Uint8Array>)) {
      lastActivity = Date.now();
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      // ffmpeg reports out_time_us and the (misnamed, also microseconds)
      // out_time_ms; fall back to parsing out_time=HH:MM:SS.micro.
      let seconds: number | null = null;
      if (key === "out_time_us" || key === "out_time_ms") {
        const us = Number(value);
        if (Number.isFinite(us)) seconds = us / 1_000_000;
      } else if (key === "out_time") {
        const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
        if (m) {
          seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        }
      }
      if (seconds !== null && opts.durationSeconds > 0) {
        opts.onProgress?.(
          Math.min(100, (seconds / opts.durationSeconds) * 100),
        );
      }
    }
  })();

  const exitCode = await proc.exited;
  clearInterval(watchdog);
  await Promise.allSettled([readStdout, readStderr]);
  activeFfmpeg = null;

  return { exitCode, stderrTail: stderrTail.trim(), killReason };
}

function baseArgs(opts: DownloadOptions): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", opts.verbose ? "info" : "error",
    "-nostats",
    "-progress", "pipe:1",
    "-rtsp_transport", "tcp",
    "-i", opts.url,
    // Safety bound: the DVR playback stream cannot run indefinitely.
    "-t", String(opts.durationSeconds),
    "-map", "0:v:0",
    "-map", "0:a?",
  ];
}

/**
 * First attempts a pure lossless remux (`-c copy`). DVRs frequently emit
 * pcm_alaw audio, which the MP4 container cannot hold; on that specific
 * failure we retry once keeping the video as a copy and transcoding only the
 * (tiny, 8 kHz mono) audio track to AAC.
 */
export async function runFfmpegDownload(opts: DownloadOptions): Promise<void> {
  const suffix = ["-movflags", "+faststart", "-y", opts.outputPath];

  if (opts.verbose) {
    const display = [...baseArgs(opts), "-c", "copy", ...suffix].map((a) =>
      a === opts.url ? opts.redactedUrl : a,
    );
    console.error(`[verbose] spawn: ffmpeg ${display.join(" ")}`);
  }

  let result = await spawnAttempt(
    ["ffmpeg", ...baseArgs(opts), "-c", "copy", ...suffix],
    opts,
  );

  if (
    result.exitCode !== 0 &&
    !result.killReason &&
    /codec not currently supported in container|could not find tag for codec/i.test(
      result.stderrTail,
    )
  ) {
    if (opts.verbose) {
      console.error(
        "[verbose] audio codec not supported in MP4; retrying with -c:v copy -c:a aac",
      );
    }
    result = await spawnAttempt(
      [
        "ffmpeg",
        ...baseArgs(opts),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "64k",
        ...suffix,
      ],
      opts,
    );
  }

  const { exitCode, stderrTail, killReason } = result;
  if (killReason) {
    throw new ExtractorError("RTSP_ERROR", killReason, stderrTail || undefined);
  }
  if (exitCode !== 0) {
    const { code, message } = classifyFfmpegError(stderrTail);
    throw new ExtractorError(code, message, stderrTail || undefined);
  }
}

export type ProbeResult = {
  sizeBytes: number;
  durationSeconds: number | null;
  hasVideo: boolean;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
};

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new ExtractorError(
      "VALIDATION_FAILED",
      `ffprobe could not read the generated file.`,
      stderr.trim() || undefined,
    );
  }

  let json: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
    format?: { duration?: string; size?: string };
  };
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ExtractorError(
      "VALIDATION_FAILED",
      "ffprobe returned unparseable output for the generated file.",
    );
  }

  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(json.format?.duration);

  return {
    sizeBytes: Number(json.format?.size ?? 0) || 0,
    durationSeconds: Number.isFinite(duration) ? duration : null,
    hasVideo: Boolean(video),
    videoCodec: video?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}
