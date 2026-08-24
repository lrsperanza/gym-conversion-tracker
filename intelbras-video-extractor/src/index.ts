import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs, HELP_TEXT } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { detectNetwork } from "./network.ts";
import {
  toIntelbrasChannel,
  buildPlaybackUrl,
  checkHttpCredentials,
} from "./intelbras.ts";
import {
  parseTimestamp,
  validateRange,
  formatDvrTimestamp,
  formatFilenameTimestamp,
  formatHumanTimestamp,
} from "./datetime.ts";
import {
  ensureFfmpegTools,
  runFfmpegDownload,
  probeFile,
  killActiveFfmpeg,
} from "./ffmpeg.ts";
import { ExtractorError, exitCodeFor } from "./errors.ts";

let partialPath: string | null = null;
let verbose = false;

function debug(message: string): void {
  if (verbose) console.error(`[verbose] ${message}`);
}

function deletePartial(): void {
  if (partialPath && existsSync(partialPath)) {
    try {
      unlinkSync(partialPath);
    } catch {
      // best effort
    }
  }
  partialPath = null;
}

function onSignal(signal: string): never {
  console.error(`\nReceived ${signal} — terminating FFmpeg and cleaning up.`);
  killActiveFfmpeg();
  deletePartial();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  verbose = opts.verbose;

  console.log("Intelbras DVR video extractor\n");

  const cfg = loadConfig();

  await ensureFfmpegTools();
  debug("ffmpeg and ffprobe found on PATH.");

  // --- time range -----------------------------------------------------------
  const start = parseTimestamp(opts.start, cfg.timezone);
  const end = parseTimestamp(opts.end, cfg.timezone);
  validateRange(start, end);
  const durationSeconds = (end.getTime() - start.getTime()) / 1000;

  const channel = toIntelbrasChannel(opts.camera);

  // --- network path detection ------------------------------------------------
  // The same DVR IP is used in both modes; the OS routing table picks the
  // actual transport. Detection exists for diagnostics and better errors.
  const report = await detectNetwork({
    dvrHost: cfg.dvrHost,
    rtspPort: cfg.rtspPort,
    httpPort: cfg.httpPort,
    gymCidr: cfg.gymCidr,
  });

  if (report.mode === "lan") {
    console.log("Network mode: LAN");
    console.log(`DVR: ${cfg.dvrHost}`);
    console.log(
      `Using direct local-network route (interface ${report.interfaceName}, ${report.address}).`,
    );
  } else if (report.mode === "tailscale") {
    console.log("Network mode: Tailscale");
    console.log(`DVR: ${cfg.dvrHost}`);
    console.log("DVR reachable through routed gym subnet.");
    console.log(`RTSP: ${report.rtspReachable ? "reachable" : "not reachable"}`);
    debug(
      `HTTP: ${report.httpReachable ? "reachable" : "not reachable"}; ` +
        `tailscale status: ${
          report.tailscaleRunning === null
            ? "unknown (CLI unavailable)"
            : report.tailscaleRunning
              ? "running"
              : "not running"
        }`,
    );
    if (!report.rtspReachable) {
      console.log(
        `Warning: RTSP port ${cfg.rtspPort} did not answer; only HTTP did. The download will probably fail.`,
      );
    }
  } else {
    throw new ExtractorError(
      "DVR_UNREACHABLE",
      `DVR ${cfg.dvrHost} is not reachable.\n\n` +
        "This machine is not on the gym LAN and no working remote route was detected.\n\n" +
        "Verify:\n" +
        "- Tailscale is connected\n" +
        "- the gym subnet router is online\n" +
        `- ${cfg.gymCidr} is advertised\n` +
        "- the subnet route has been approved\n" +
        "- the client is allowed to use the route",
    );
  }

  // --- optional HTTP Digest preflight ---------------------------------------
  debug("Running HTTP API credential preflight (magicBox.cgi)...");
  const preflight = await checkHttpCredentials(cfg);
  if (preflight === "ok") {
    console.log("HTTP API: credentials accepted.");
  } else if (preflight === "auth_failed") {
    throw new ExtractorError(
      "AUTH_FAILED",
      "The DVR HTTP API rejected the credentials (Digest auth failed).\n\n" +
        "INTELBRAS_USER / INTELBRAS_PASSWORD must be the LOCAL DVR/NVR " +
        "credentials, not the Intelbras/iSIC cloud account.",
    );
  } else {
    debug(`HTTP preflight inconclusive (${preflight}); continuing with RTSP.`);
  }

  // --- build the playback request --------------------------------------------
  const startDvr = formatDvrTimestamp(start, cfg.timezone);
  const endDvr = formatDvrTimestamp(end, cfg.timezone);
  const { url, redacted } = buildPlaybackUrl({
    host: cfg.dvrHost,
    port: cfg.rtspPort,
    channel,
    user: cfg.user,
    password: cfg.password,
    startDvr,
    endDvr,
  });

  console.log("");
  console.log(`Camera index: ${opts.camera}`);
  console.log(`Intelbras channel: ${channel}`);
  console.log("");
  console.log(`Start: ${formatHumanTimestamp(start, cfg.timezone)}`);
  console.log(`End:   ${formatHumanTimestamp(end, cfg.timezone)}`);
  console.log(`Duration: ${Math.round(durationSeconds)} seconds`);
  debug(`RTSP URL (redacted): ${redacted}`);

  // --- output paths -----------------------------------------------------------
  let finalPath: string;
  if (opts.output) {
    finalPath = path.resolve(opts.output);
  } else {
    const name =
      `camera-${opts.camera}_${formatFilenameTimestamp(start, cfg.timezone)}` +
      `_${formatFilenameTimestamp(end, cfg.timezone)}.mp4`;
    finalPath = path.resolve(opts.outputDir, name);
  }
  mkdirSync(path.dirname(finalPath), { recursive: true });

  partialPath = finalPath.replace(/\.mp4$/i, "") + ".partial.mp4";

  // --- retrieval ---------------------------------------------------------------
  console.log("");
  console.log("Retrieving recording...");
  let lastPrintedPct = -1;
  try {
    await runFfmpegDownload({
      url,
      redactedUrl: redacted,
      // FFmpeg echoes the input URL in its stderr — scrub every form of the
      // credential from captured output before it can reach a log.
      secrets: [url, cfg.password, encodeURIComponent(cfg.password)],
      durationSeconds,
      outputPath: partialPath,
      verbose,
      onProgress: (pct) => {
        const whole = Math.floor(pct);
        if (whole > lastPrintedPct) {
          lastPrintedPct = whole;
          console.log(`Downloading: ${whole}%`);
        }
      },
    });
  } catch (err) {
    deletePartial();
    throw err;
  }

  // --- validation ---------------------------------------------------------------
  console.log("Validating output...");

  if (!existsSync(partialPath) || statSync(partialPath).size === 0) {
    deletePartial();
    throw new ExtractorError(
      "NO_RECORDING",
      "The DVR returned no data for the requested interval — most likely " +
        "there is no recording for this camera/period, or the channel number " +
        "does not exist on this device.",
    );
  }

  let probe;
  try {
    probe = await probeFile(partialPath);
  } catch (err) {
    deletePartial();
    throw err;
  }

  if (!probe.hasVideo || !probe.durationSeconds || probe.durationSeconds <= 0) {
    deletePartial();
    throw new ExtractorError(
      "NO_RECORDING",
      "The generated file has no usable video stream — most likely there is " +
        "no recording for the requested interval on this camera.",
    );
  }

  // Small duration differences are expected (keyframe alignment, container
  // rounding); only warn, never fail.
  const durationDelta = Math.abs(probe.durationSeconds - durationSeconds);
  const tolerance = Math.max(5, durationSeconds * 0.1);
  let durationNote = "";
  if (durationDelta > tolerance) {
    durationNote =
      ` (warning: differs from the requested ${Math.round(durationSeconds)}s ` +
      `by ${durationDelta.toFixed(1)}s — DVR keyframe boundaries can shift the clip)`;
  }

  renameSync(partialPath, finalPath);
  partialPath = null;

  console.log("");
  console.log(
    `Video codec: ${(probe.videoCodec ?? "unknown").toUpperCase()}`,
  );
  console.log(
    `Resolution: ${probe.width && probe.height ? `${probe.width}x${probe.height}` : "unknown"}`,
  );
  console.log(
    `Duration: ${probe.durationSeconds.toFixed(1)} seconds${durationNote}`,
  );
  console.log(`Size: ${formatBytes(probe.sizeBytes)}`);
  console.log("");
  console.log("SUCCESS");
  console.log(finalPath);
  return 0;
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    deletePartial();
    if (err instanceof ExtractorError) {
      console.error(`\nERROR [${err.code}]: ${err.message}`);
      if (verbose && err.details) {
        console.error(`\n--- ffmpeg/tool output ---\n${err.details}`);
      } else if (err.details) {
        console.error("(run again with --verbose to see the raw tool output)");
      }
      process.exit(exitCodeFor(err.code));
    }
    console.error("\nUnexpected error:", err);
    process.exit(1);
  });
