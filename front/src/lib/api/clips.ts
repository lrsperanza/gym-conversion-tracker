import { api, ApiError } from './client';
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

export async function fetchClipUrl(jobId: string) {
	const response = await fetch(`${await resolveApiHostUrl()}/api/clips/jobs/${jobId}/stream`, {
		credentials: 'include'
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new ApiError(payload?.error?.message || 'Erro ao carregar vídeo.', response.status, payload?.error?.details);
	}
	return URL.createObjectURL(await response.blob());
}
