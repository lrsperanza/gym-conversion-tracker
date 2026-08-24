import { ExtractorError } from "./errors.ts";

export type Config = {
  dvrHost: string;
  rtspPort: number;
  httpPort: number;
  user: string;
  password: string;
  gymCidr: string;
  timezone: string;
};

export const DEFAULTS = {
  DVR_HOST: "192.168.1.191",
  RTSP_PORT: 554,
  HTTP_PORT: 80,
  GYM_CIDR: "192.168.1.0/24",
  TIMEZONE: "America/Sao_Paulo",
} as const;

function envOr(name: string, fallback: string): string {
  const value = Bun.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function parsePort(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ExtractorError(
      "CONFIG_ERROR",
      `Invalid ${name}="${raw}": expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

export function loadConfig(): Config {
  const user = (Bun.env.INTELBRAS_USER ?? "").trim();
  const password = Bun.env.INTELBRAS_PASSWORD ?? "";

  if (!user || !password) {
    throw new ExtractorError(
      "CONFIG_ERROR",
      "Missing DVR credentials.\n\n" +
        "Set INTELBRAS_USER and INTELBRAS_PASSWORD in a local .env file " +
        "(copy .env.example). These are the LOCAL DVR/NVR credentials, not the " +
        "Intelbras/iSIC cloud account. Never pass credentials as command-line " +
        "arguments — they would leak through the process list and shell history.",
    );
  }

  const timezone = envOr("GYM_TIMEZONE", DEFAULTS.TIMEZONE);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ExtractorError(
      "CONFIG_ERROR",
      `Invalid GYM_TIMEZONE="${timezone}": not a valid IANA time zone name.`,
    );
  }

  const gymCidr = envOr("GYM_CIDR", DEFAULTS.GYM_CIDR);
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(gymCidr)) {
    throw new ExtractorError(
      "CONFIG_ERROR",
      `Invalid GYM_CIDR="${gymCidr}": expected IPv4 CIDR notation such as 192.168.1.0/24.`,
    );
  }

  return {
    dvrHost: envOr("INTELBRAS_DVR_HOST", DEFAULTS.DVR_HOST),
    rtspPort: parsePort("INTELBRAS_RTSP_PORT", DEFAULTS.RTSP_PORT),
    httpPort: parsePort("INTELBRAS_HTTP_PORT", DEFAULTS.HTTP_PORT),
    user,
    password,
    gymCidr,
    timezone,
  };
}
