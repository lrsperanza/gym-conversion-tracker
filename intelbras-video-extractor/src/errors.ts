export const ERROR_CODES = [
  "INVALID_ARGUMENTS",
  "CONFIG_ERROR",
  "DVR_UNREACHABLE",
  "AUTH_FAILED",
  "NO_RECORDING",
  "INVALID_CAMERA",
  "FFMPEG_NOT_FOUND",
  "RTSP_ERROR",
  "VALIDATION_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ExtractorError extends Error {
  readonly code: ErrorCode;
  readonly details?: string;

  constructor(code: ErrorCode, message: string, details?: string) {
    super(message);
    this.name = "ExtractorError";
    this.code = code;
    this.details = details;
  }
}

export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case "INVALID_ARGUMENTS":
    case "CONFIG_ERROR":
    case "INVALID_CAMERA":
      return 2;
    default:
      return 1;
  }
}
