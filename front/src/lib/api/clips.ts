import { api } from './client';
import { resolveApiHostUrl } from './hosts';
import type { AcademyCamera, ClipJob } from '$lib/types';

export async function listClipCameras(academyId: string) {
	return await api<{ cameras: AcademyCamera[]; maxDurationMinutes: number }>(
		`/api/clips/cameras?academyId=${encodeURIComponent(academyId)}`
	);
}

export async function createClip(attendanceId: string, cameraId: string, start: string, end: string) {
	const data = await api<{ job: ClipJob }>(`/api/attendances/${attendanceId}/clips`, {
		method: 'POST',
		body: JSON.stringify({ cameraId, start, end })
	});
	return data.job;
}

export async function getClipJob(jobId: string) {
	const data = await api<{ job: ClipJob }>(`/api/clips/jobs/${jobId}`);
	return data.job;
}

export async function clipStreamUrl(jobId: string, atSeconds = 0, rate = 8) {
	const params = new URLSearchParams({
		at: String(Math.max(0, Math.floor(atSeconds))),
		rate: String(rate)
	});
	return `${await resolveApiHostUrl()}/api/clips/jobs/${jobId}/stream?${params}`;
}
