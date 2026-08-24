import { ExtractorError } from "./errors.ts";

export type CliOptions = {
  help: boolean;
  verbose: boolean;
  camera: number;
  start: string;
  end: string;
  output: string | null;
  outputDir: string;
};

export const HELP_TEXT = `Intelbras DVR video extractor

Downloads an exact recorded-video interval from an Intelbras DVR/NVR over
RTSP playback (lossless remux via FFmpeg).

Usage:

  bun run src/index.ts \\
    --camera 0 \\
    --start "2026-08-24T09:30:00-03:00" \\
    --end   "2026-08-24T09:35:00-03:00"

Required:
  --camera      Zero-based camera index (0 = Intelbras channel 1,
                1 = channel 2, ...). Must be a non-negative integer.
  --start       Start timestamp. ISO-8601 with offset, e.g.
                "2026-08-24T09:30:00-03:00". Without an offset
                ("2026-08-24 09:30:00") it is interpreted in
                GYM_TIMEZONE (default America/Sao_Paulo).
  --end         End timestamp. Same rules as --start.

Optional:
  --output      Full output file path (overrides the generated name).
  --output-dir  Output directory (default: ./clips).
  --verbose     Extra diagnostics, including FFmpeg stderr.
  --help, -h    Show this help.

Configuration (.env — never pass credentials on the command line):
  INTELBRAS_DVR_HOST    (default 192.168.1.191)
  INTELBRAS_RTSP_PORT   (default 554)
  INTELBRAS_HTTP_PORT   (default 80)
  INTELBRAS_USER        local DVR/NVR username (required)
  INTELBRAS_PASSWORD    local DVR/NVR password (required)
  GYM_CIDR              (default 192.168.1.0/24)
  GYM_TIMEZONE          (default America/Sao_Paulo)

Network behavior:
  - If this machine has an active non-Tailscale interface inside GYM_CIDR,
    the DVR is reached directly over the LAN (Tailscale not required).
  - Otherwise the same DVR IP (192.168.1.191) is used and the OS routes it
    through the Tailscale subnet router, if one is configured.

Exit codes:
  0  success (prints the absolute path of the generated video)
  1  runtime failure (DVR_UNREACHABLE, AUTH_FAILED, NO_RECORDING,
     FFMPEG_NOT_FOUND, RTSP_ERROR, VALIDATION_FAILED)
  2  invalid arguments / configuration
`;

export function parseCameraIndex(raw: string): number {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) {
    throw new ExtractorError(
      "INVALID_CAMERA",
      `Invalid camera index "${raw}": expected a zero-based non-negative integer ` +
        `(0 = Intelbras channel 1, 1 = channel 2, ...).`,
    );
  }
  return Number(t);
}

function takeValue(
  argv: string[],
  index: number,
  inline: string | undefined,
  flag: string,
): { value: string; consumed: number } {
  if (inline !== undefined) return { value: inline, consumed: 0 };
  const next = argv[index + 1];
  if (next === undefined) {
    throw new ExtractorError(
      "INVALID_ARGUMENTS",
      `Missing value for ${flag}. Run with --help for usage.`,
    );
  }
  return { value: next, consumed: 1 };
}

export function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let verbose = false;
  let cameraRaw: string | null = null;
  let start: string | null = null;
  let end: string | null = null;
  let output: string | null = null;
  let outputDir = "clips";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;

    switch (flag) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--camera": {
        const { value, consumed } = takeValue(argv, i, inline, flag);
        cameraRaw = value;
        i += consumed;
        break;
      }
      case "--start": {
        const { value, consumed } = takeValue(argv, i, inline, flag);
        start = value;
        i += consumed;
        break;
      }
      case "--end": {
        const { value, consumed } = takeValue(argv, i, inline, flag);
        end = value;
        i += consumed;
        break;
      }
      case "--output": {
        const { value, consumed } = takeValue(argv, i, inline, flag);
        output = value;
        i += consumed;
        break;
      }
      case "--output-dir": {
        const { value, consumed } = takeValue(argv, i, inline, flag);
        outputDir = value;
        i += consumed;
        break;
      }
      default:
        throw new ExtractorError(
          "INVALID_ARGUMENTS",
          `Unknown argument "${arg}". Run with --help for usage.`,
        );
    }
  }

  if (help) {
    return {
      help: true,
      verbose,
      camera: 0,
      start: "",
      end: "",
      output,
      outputDir,
    };
  }

  const missing: string[] = [];
  if (cameraRaw === null) missing.push("--camera");
  if (start === null) missing.push("--start");
  if (end === null) missing.push("--end");
  if (missing.length > 0) {
    throw new ExtractorError(
      "INVALID_ARGUMENTS",
      `Missing required argument(s): ${missing.join(", ")}.\n\nRun with --help for usage.`,
    );
  }

  return {
    help,
    verbose,
    camera: parseCameraIndex(cameraRaw!),
    start: start!,
    end: end!,
    output,
    outputDir,
  };
}
