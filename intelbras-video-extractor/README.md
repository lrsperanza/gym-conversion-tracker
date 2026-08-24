# Intelbras DVR Video Extractor

Bun + TypeScript CLI that downloads an **exact recorded-video interval** from a
local Intelbras DVR/NVR, using the DVR's RTSP playback endpoint and FFmpeg
(lossless remux — no re-encoding).

```text
DVR stored stream → RTSP (/cam/playback) → FFmpeg (-c copy) → MP4
```

The video comes **directly from the DVR/NVR** on the local network. This tool
does **not** use the Intelbras cloud/iSIC API.

## What it does

Given `--start`, `--end` and a zero-based `--camera` index, it:

1. Detects whether the machine is on the gym LAN or remote (diagnostics only).
2. Builds an authenticated Intelbras playback URL:
   `rtsp://<host>:554/cam/playback?channel=N&starttime=YYYY_MM_DD_HH_MM_SS&endtime=...`
3. Downloads the stream over **RTSP-over-TCP** with FFmpeg, remuxing to MP4
   (video copied losslessly; G.711 audio is transcoded to AAC when the DVR
   serves `pcm_alaw`, which MP4 cannot hold).
4. Validates the result with FFprobe (video stream present, sane duration).
5. Atomically renames the partial file and prints the **absolute output path**.

## Prerequisites

- **Bun** (https://bun.sh) — the script runs as `bun run src/index.ts`.
- **FFmpeg** — both `ffmpeg` and `ffprobe` must be on `PATH`.
  - Windows: `winget install ffmpeg` or https://www.gyan.dev/ffmpeg/builds/
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
- Network reachability to the DVR (see below).

## Configuration

```bash
cp .env.example .env   # then edit .env
```

```env
INTELBRAS_DVR_HOST=192.168.1.191
INTELBRAS_RTSP_PORT=554
INTELBRAS_HTTP_PORT=80

INTELBRAS_USER=        # LOCAL DVR/NVR username (required)
INTELBRAS_PASSWORD=    # LOCAL DVR/NVR password (required)

GYM_CIDR=192.168.1.0/24
GYM_TIMEZONE=America/Sao_Paulo
```

The credentials are the **local DVR/NVR credentials** (the ones you type into
the recorder's web interface), **not** your Intelbras/iSIC cloud account.

Bun reads `.env` automatically. `.env` is git-ignored — never commit real
credentials.

## Usage

```bash
bun run src/index.ts \
  --camera 0 \
  --start "2026-08-24T09:30:00-03:00" \
  --end   "2026-08-24T09:35:00-03:00"
```

Output:

```text
./clips/camera-0_2026-08-24_09-30-00_2026-08-24_09-35-00.mp4
```

Options:

| Flag | Description |
|------|-------------|
| `--camera` | Zero-based camera index (required) |
| `--start` / `--end` | ISO-8601 timestamps (required). Without an offset they are interpreted in `GYM_TIMEZONE` (never silently as UTC). |
| `--output <file>` | Exact output file path |
| `--output-dir <dir>` | Output directory (default `./clips`) |
| `--verbose` | Extra diagnostics incl. FFmpeg stderr |
| `--help` | Usage |

Exit codes: `0` success (absolute path printed), `1` runtime failure,
`2` invalid arguments/configuration.

## Camera index mapping

The CLI is **zero-based**; Intelbras channels are one-based:

```text
--camera 0 → Intelbras channel=1
--camera 1 → Intelbras channel=2
--camera 2 → Intelbras channel=3
```

Negative and non-integer indexes are rejected (`INVALID_CAMERA`).

## Network behavior

The DVR address is **`192.168.1.191` in both scenarios**. The tool never
substitutes a Tailscale `100.x` address and never configures the VPN; the OS
routing table picks the transport.

### On the gym LAN

If the machine has an active **non-Tailscale** interface inside
`192.168.1.0/24`:

```text
Network mode: LAN
DVR: 192.168.1.191
Using direct local-network route.
```

The DVR is contacted directly over Ethernet/Wi-Fi. **Tailscale is not
required** — it may be stopped or not installed at all.

### Remote (Tailscale subnet router)

If no LAN interface matches, the tool probes `192.168.1.191:554` (and `:80`).
It assumes a **Tailscale subnet router at the gym already advertises
`192.168.1.0/24`** and the route is approved/accepted. When reachable:

```text
Network mode: Tailscale
DVR reachable through routed gym subnet.
```

```text
Remote computer → Tailscale → gym subnet router → 192.168.1.191 → DVR
```

The script itself **does not** run `tailscale up`, `tailscale set`, or make
any persistent network changes. `tailscale status --json` is checked only as
a best-effort diagnostic — a working OS-level route is sufficient.

If the DVR is unreachable remotely you get:

```text
ERROR [DVR_UNREACHABLE]: DVR 192.168.1.191 is not reachable.
...verify Tailscale connection, subnet router, advertised/approved route...
```

## Security

- Credentials come only from the environment/`.env` — never from CLI args.
- Passwords are never logged; the RTSP URL is logged only in redacted form
  (`rtsp://USER:***@...`) and only with `--verbose`.
- Credentials are percent-encoded into the RTSP URL and FFmpeg is spawned
  with an argument array (no shell), so special characters can't break
  quoting. If a specific DVR firmware turns out to reject percent-encoded
  credentials, that's a device limitation — use credentials without reserved
  characters.
- Passwords never appear in generated filenames.
- **Do not expose ports 554 / 80 / 37777 to the public Internet** and do not
  set up router port forwarding. Remote access goes through the existing
  Tailscale network only.

## Output handling

- FFmpeg writes to `*.partial.mp4`; the file is atomically renamed to the
  final name only after FFmpeg succeeds **and** FFprobe validation passes.
- On failure or Ctrl+C/SIGTERM the partial file is deleted and the FFmpeg
  child process is killed (no orphans).
- The output directory (`./clips` by default) is created automatically.
- Small duration differences vs. the requested interval are normal (DVR
  keyframe boundaries) and only produce a warning, not a failure.

## Troubleshooting

- **`pcm_alaw` / "codec not currently supported in container"**: Intelbras
  DVRs record audio as G.711 A-law (`pcm_alaw`), which the MP4 container
  cannot hold with stream copy. The tool detects this automatically and
  retries with `-c:v copy -c:a aac` — the **video stays a lossless copy**;
  only the tiny 8 kHz mono audio track is transcoded.
- **Slow downloads**: many DVR firmwares stream playback at realtime speed
  (`speed=1x`), so a 5-minute clip takes ~5 minutes. The overall timeout
  already scales with the requested duration — just let it run.
- **"Non-monotonic DTS" warnings (verbose)**: DVR playback streams have
  imperfect timestamps; FFmpeg normalizes them. Cosmetic, harmless.
- **`AUTH_FAILED`**: you are probably using the Intelbras/iSIC cloud account
  instead of the recorder's local user. Fix `INTELBRAS_USER` /
  `INTELBRAS_PASSWORD` in `.env`.
- **`NO_RECORDING`**: check that the interval exists in the DVR's playback
  timeline for that channel, and that `--camera` maps to the channel you
  expect (`--camera 0` = channel 1).
- **`RTSP_ERROR` / stalls**: prefer running on the LAN; over Tailscale the
  subnet router's bandwidth/CPU bounds the stream.

## Error codes

| Code | Meaning |
|------|---------|
| `DVR_UNREACHABLE` | No route to the DVR (LAN down / Tailscale route missing) |
| `AUTH_FAILED` | Credentials rejected (HTTP Digest preflight or RTSP 401) |
| `NO_RECORDING` | No recording for the requested interval/channel |
| `INVALID_CAMERA` | Bad `--camera` value |
| `FFMPEG_NOT_FOUND` | `ffmpeg`/`ffprobe` not on PATH |
| `RTSP_ERROR` | Stream stalled/timed out or FFmpeg transport failure |
| `INVALID_ARGUMENTS` / `CONFIG_ERROR` | Bad CLI args or missing env |

The overall retrieval timeout scales with the requested clip duration (a
30-minute clip is allowed much longer than a 10-second one), plus a 30s
stalled-stream watchdog.

## Tests

```bash
bun install
bun test
bun run typecheck
bun run src/index.ts --help
```

## Standalone executable

```bash
bun run build
```

Produces `dist/intelbras-video-extractor.exe` (Windows x64, Bun compiled —
no Bun installation needed on the target machine). FFmpeg is **not** embedded:
`ffmpeg` and `ffprobe` must still be on the target's `PATH`, and a `.env` (or
environment variables) must be present next to wherever you run it.

```powershell
.\dist\intelbras-video-extractor.exe --camera 0 `
  --start "2026-08-24T09:30:00-03:00" `
  --end "2026-08-24T09:35:00-03:00"
```

Unit tests cover camera mapping, timestamp parsing/formatting in
`America/Sao_Paulo`, interval validation, RTSP URL construction/redaction,
Digest-auth header building and CIDR detection. Anything involving the actual
DVR (RTSP handshake, playback correctness) requires live integration testing
against the recorder.

## Project layout

```text
intelbras-video-extractor/
├── src/
│   ├── index.ts      # orchestration, signals, cleanup, summary output
│   ├── cli.ts        # argument parsing + --help
│   ├── config.ts     # env loading + defaults (all constants centralized)
│   ├── network.ts    # LAN/Tailscale detection, TCP reachability, CIDR math
│   ├── intelbras.ts  # channel mapping, playback URL, HTTP Digest preflight
│   ├── ffmpeg.ts     # FFmpeg spawn (no shell), progress parsing, FFprobe
│   ├── datetime.ts   # timezone-aware parsing/formatting
│   └── errors.ts     # typed error codes + exit codes
├── tests/
├── clips/            # default output (git-ignored)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```
