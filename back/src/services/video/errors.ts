export const VIDEO_ERROR_CODES = [
	'INVALID_ARGUMENTS',
	'CONFIG_ERROR',
	'DVR_UNREACHABLE',
	'AUTH_FAILED',
	'NO_RECORDING',
	'INVALID_CAMERA',
	'FFMPEG_NOT_FOUND',
	'RTSP_ERROR',
	'VALIDATION_FAILED'
] as const;

export type VideoErrorCode = (typeof VIDEO_ERROR_CODES)[number];

export class VideoExtractorError extends Error {
	constructor(
		public readonly code: VideoErrorCode,
		message: string,
		public readonly details?: string
	) {
		super(message);
		this.name = 'VideoExtractorError';
	}
}
