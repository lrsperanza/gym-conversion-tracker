import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from '../db/client';
import { assertCanAccessAcademy, canManageProfessor, requireAuth } from '../http/auth';
import { badRequest, forbidden, notFound } from '../http/errors';
import type { AppBindings, SessionUser } from '../http/types';
import { decryptCameraPassword, encryptCameraPassword } from '../security/cameraCrypto';
import { audit } from '../services/audit';
import { checkHttpCredentials } from '../services/video/intelbras';
import { checkTcp } from '../services/video/network';

export const cameraAdminRoutes = new Hono<AppBindings>();

cameraAdminRoutes.use('*', requireAuth);

const dvrInputSchema = z.object({
	name: z.string().trim().min(1),
	host: z.string().trim().min(1),
	rtspPort: z.number().int().positive().max(65535).default(554),
	httpPort: z.number().int().positive().max(65535).default(80),
	username: z.string().trim().min(1),
	password: z.string().min(1),
	active: z.boolean().optional()
});

const dvrPatchSchema = dvrInputSchema.partial();

const cameraInputSchema = z.object({
	name: z.string().trim().min(1),
	channel: z.number().int().positive(),
	isDefault: z.boolean().default(false),
	active: z.boolean().optional(),
	sortOrder: z.number().int().default(0)
});

const cameraPatchSchema = cameraInputSchema.partial();

type DvrRow = {
	id: string;
	academyId: string;
	name: string;
	host: string;
	rtspPort: number;
	httpPort: number;
	username: string;
	active: boolean;
	hasPassword: boolean;
	createdAt: string;
	updatedAt: string;
};

type CameraRow = {
	id: string;
	dvrId: string;
	academyId: string;
	name: string;
	channel: number;
	isDefault: boolean;
	active: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
};

function canManageVideo(actor: SessionUser, academyId: string, action: 'create' | 'update' | 'deactivate') {
	return canManageProfessor(actor, academyId, action);
}

async function getDvrAcademyId(dvrId: string): Promise<string> {
	const [row] = await sql<Array<{ academy_id: string }>>`
		SELECT "academy_id"
		FROM "gym-conversion-tracker"."academy_dvrs"
		WHERE "id" = ${dvrId}
	`;
	if (!row) throw notFound();
	return row.academy_id;
}

async function getCameraAcademyId(cameraId: string): Promise<string> {
	const [row] = await sql<Array<{ academy_id: string }>>`
		SELECT d."academy_id"
		FROM "gym-conversion-tracker"."academy_cameras" c
		JOIN "gym-conversion-tracker"."academy_dvrs" d ON d."id" = c."dvr_id"
		WHERE c."id" = ${cameraId}
	`;
	if (!row) throw notFound();
	return row.academy_id;
}

function selectDvrsForAcademy(academyId: string) {
	return sql<DvrRow[]>`
		SELECT
			"id",
			"academy_id" AS "academyId",
			"name",
			"host",
			"rtsp_port" AS "rtspPort",
			"http_port" AS "httpPort",
			"username",
			"active",
			("password_encrypted" IS NOT NULL) AS "hasPassword",
			"created_at" AS "createdAt",
			"updated_at" AS "updatedAt"
		FROM "gym-conversion-tracker"."academy_dvrs"
		WHERE "academy_id" = ${academyId}
		ORDER BY "active" DESC, "name"
	`;
}

async function selectCamerasForDvrs(dvrIds: string[]) {
	if (!dvrIds.length) return [];
	return await sql<CameraRow[]>`
		SELECT
			c."id",
			c."dvr_id" AS "dvrId",
			d."academy_id" AS "academyId",
			c."name",
			c."channel",
			c."is_default" AS "isDefault",
			c."active",
			c."sort_order" AS "sortOrder",
			c."created_at" AS "createdAt",
			c."updated_at" AS "updatedAt"
		FROM "gym-conversion-tracker"."academy_cameras" c
		JOIN "gym-conversion-tracker"."academy_dvrs" d ON d."id" = c."dvr_id"
		WHERE c."dvr_id" IN ${sql(dvrIds)}
		ORDER BY c."active" DESC, c."sort_order", c."name"
	`;
}

cameraAdminRoutes.get('/academies/:academyId/dvrs', async (c) => {
	const user = c.get('user');
	const academyId = c.req.param('academyId');
	assertCanAccessAcademy(user, academyId);

	const dvrs = await selectDvrsForAcademy(academyId);
	const cameras = await selectCamerasForDvrs(dvrs.map((dvr) => dvr.id));
	return c.json({
		dvrs: dvrs.map((dvr) => ({
			...dvr,
			cameras: cameras.filter((camera) => camera.dvrId === dvr.id)
		}))
	});
});

cameraAdminRoutes.post('/academies/:academyId/dvrs', async (c) => {
	const user = c.get('user');
	const academyId = c.req.param('academyId');
	if (!canManageVideo(user, academyId, 'create')) throw forbidden();
	const input = dvrInputSchema.parse(await c.req.json());

	const [dvr] = await sql<DvrRow[]>`
		INSERT INTO "gym-conversion-tracker"."academy_dvrs"
			("academy_id", "name", "host", "rtsp_port", "http_port", "username", "password_encrypted", "active")
		VALUES (
			${academyId},
			${input.name},
			${input.host},
			${input.rtspPort},
			${input.httpPort},
			${input.username},
			${encryptCameraPassword(input.password)},
			${input.active ?? true}
		)
		RETURNING
			"id",
			"academy_id" AS "academyId",
			"name",
			"host",
			"rtsp_port" AS "rtspPort",
			"http_port" AS "httpPort",
			"username",
			"active",
			("password_encrypted" IS NOT NULL) AS "hasPassword",
			"created_at" AS "createdAt",
			"updated_at" AS "updatedAt"
	`;
	if (!dvr) throw new Error('Falha ao cadastrar DVR.');
	await audit({ actorUserId: user.id, action: 'camera.dvr_create', entityType: 'academy_dvr', entityId: dvr.id, payload: { ...input, password: 'provided' }, c });
	return c.json({ dvr }, 201);
});

cameraAdminRoutes.patch('/dvrs/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const academyId = await getDvrAcademyId(id);
	if (!canManageVideo(user, academyId, 'update')) throw forbidden();
	const input = dvrPatchSchema.parse(await c.req.json());
	if (!Object.keys(input).length) throw badRequest('Nada para atualizar.');

	const [dvr] = await sql<DvrRow[]>`
		UPDATE "gym-conversion-tracker"."academy_dvrs"
		SET
			"name" = COALESCE(${input.name ?? null}, "name"),
			"host" = COALESCE(${input.host ?? null}, "host"),
			"rtsp_port" = COALESCE(${input.rtspPort ?? null}, "rtsp_port"),
			"http_port" = COALESCE(${input.httpPort ?? null}, "http_port"),
			"username" = COALESCE(${input.username ?? null}, "username"),
			"password_encrypted" = COALESCE(${input.password ? encryptCameraPassword(input.password) : null}, "password_encrypted"),
			"active" = COALESCE(${input.active ?? null}, "active"),
			"updated_at" = now()
		WHERE "id" = ${id}
		RETURNING
			"id",
			"academy_id" AS "academyId",
			"name",
			"host",
			"rtsp_port" AS "rtspPort",
			"http_port" AS "httpPort",
			"username",
			"active",
			("password_encrypted" IS NOT NULL) AS "hasPassword",
			"created_at" AS "createdAt",
			"updated_at" AS "updatedAt"
	`;
	if (!dvr) throw notFound();
	await audit({ actorUserId: user.id, action: 'camera.dvr_update', entityType: 'academy_dvr', entityId: id, payload: { ...input, password: input.password ? 'provided' : undefined }, c });
	return c.json({ dvr });
});

cameraAdminRoutes.delete('/dvrs/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const academyId = await getDvrAcademyId(id);
	if (!canManageVideo(user, academyId, 'deactivate')) throw forbidden();

	await sql`
		UPDATE "gym-conversion-tracker"."academy_dvrs"
		SET "active" = false, "updated_at" = now()
		WHERE "id" = ${id}
	`;
	await sql`
		UPDATE "gym-conversion-tracker"."academy_cameras"
		SET "active" = false, "is_default" = false, "updated_at" = now()
		WHERE "dvr_id" = ${id}
	`;
	await audit({ actorUserId: user.id, action: 'camera.dvr_deactivate', entityType: 'academy_dvr', entityId: id, c });
	return c.json({ ok: true });
});

cameraAdminRoutes.post('/dvrs/:id/cameras', async (c) => {
	const user = c.get('user');
	const dvrId = c.req.param('id');
	const academyId = await getDvrAcademyId(dvrId);
	if (!canManageVideo(user, academyId, 'create')) throw forbidden();
	const input = cameraInputSchema.parse(await c.req.json());

	const [camera] = await sql.begin(async (tx) => {
		if (input.isDefault) {
			await tx`
				UPDATE "gym-conversion-tracker"."academy_cameras" c
				SET "is_default" = false, "updated_at" = now()
				FROM "gym-conversion-tracker"."academy_dvrs" d
				WHERE c."dvr_id" = d."id"
					AND d."academy_id" = ${academyId}
					AND c."is_default" = true
			`;
		}
		return await tx<CameraRow[]>`
			INSERT INTO "gym-conversion-tracker"."academy_cameras"
				("dvr_id", "name", "channel", "is_default", "active", "sort_order")
			VALUES (${dvrId}, ${input.name}, ${input.channel}, ${input.isDefault}, ${input.active ?? true}, ${input.sortOrder})
			RETURNING
				"id",
				"dvr_id" AS "dvrId",
				${academyId} AS "academyId",
				"name",
				"channel",
				"is_default" AS "isDefault",
				"active",
				"sort_order" AS "sortOrder",
				"created_at" AS "createdAt",
				"updated_at" AS "updatedAt"
		`;
	});
	if (!camera) throw new Error('Falha ao cadastrar camera.');
	await audit({ actorUserId: user.id, action: 'camera.create', entityType: 'academy_camera', entityId: camera.id, payload: input, c });
	return c.json({ camera }, 201);
});

cameraAdminRoutes.patch('/cameras/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const academyId = await getCameraAcademyId(id);
	if (!canManageVideo(user, academyId, 'update')) throw forbidden();
	const input = cameraPatchSchema.parse(await c.req.json());
	if (!Object.keys(input).length) throw badRequest('Nada para atualizar.');

	const [camera] = await sql.begin(async (tx) => {
		if (input.isDefault) {
			await tx`
				UPDATE "gym-conversion-tracker"."academy_cameras" c
				SET "is_default" = false, "updated_at" = now()
				FROM "gym-conversion-tracker"."academy_dvrs" d
				WHERE c."dvr_id" = d."id"
					AND d."academy_id" = ${academyId}
					AND c."is_default" = true
			`;
		}
		return await tx<CameraRow[]>`
			UPDATE "gym-conversion-tracker"."academy_cameras" c
			SET
				"name" = COALESCE(${input.name ?? null}, c."name"),
				"channel" = COALESCE(${input.channel ?? null}, c."channel"),
				"is_default" = COALESCE(${input.active === false ? false : (input.isDefault ?? null)}, c."is_default"),
				"active" = COALESCE(${input.active ?? null}, c."active"),
				"sort_order" = COALESCE(${input.sortOrder ?? null}, c."sort_order"),
				"updated_at" = now()
			FROM "gym-conversion-tracker"."academy_dvrs" d
			WHERE c."id" = ${id} AND d."id" = c."dvr_id"
			RETURNING
				c."id",
				c."dvr_id" AS "dvrId",
				d."academy_id" AS "academyId",
				c."name",
				c."channel",
				c."is_default" AS "isDefault",
				c."active",
				c."sort_order" AS "sortOrder",
				c."created_at" AS "createdAt",
				c."updated_at" AS "updatedAt"
		`;
	});
	if (!camera) throw notFound();
	await audit({ actorUserId: user.id, action: 'camera.update', entityType: 'academy_camera', entityId: id, payload: input, c });
	return c.json({ camera });
});

cameraAdminRoutes.delete('/cameras/:id', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const academyId = await getCameraAcademyId(id);
	if (!canManageVideo(user, academyId, 'deactivate')) throw forbidden();

	await sql`
		UPDATE "gym-conversion-tracker"."academy_cameras"
		SET "active" = false, "is_default" = false, "updated_at" = now()
		WHERE "id" = ${id}
	`;
	await audit({ actorUserId: user.id, action: 'camera.deactivate', entityType: 'academy_camera', entityId: id, c });
	return c.json({ ok: true });
});

cameraAdminRoutes.post('/dvrs/:id/test', async (c) => {
	const user = c.get('user');
	const id = c.req.param('id');
	const [dvr] = await sql<
		Array<{
			id: string;
			academy_id: string;
			host: string;
			rtsp_port: number;
			http_port: number;
			username: string;
			password_encrypted: string;
		}>
	>`
		SELECT "id", "academy_id", "host", "rtsp_port", "http_port", "username", "password_encrypted"
		FROM "gym-conversion-tracker"."academy_dvrs"
		WHERE "id" = ${id}
	`;
	if (!dvr) throw notFound();
	if (!canManageVideo(user, dvr.academy_id, 'update')) throw forbidden();

	const [rtspReachable, httpReachable, credentialStatus] = await Promise.all([
		checkTcp(dvr.host, dvr.rtsp_port, 3000),
		checkTcp(dvr.host, dvr.http_port, 3000),
		checkHttpCredentials({
			host: dvr.host,
			rtspPort: dvr.rtsp_port,
			httpPort: dvr.http_port,
			username: dvr.username,
			password: decryptCameraPassword(dvr.password_encrypted)
		})
	]);

	return c.json({
		result: {
			ok: rtspReachable && credentialStatus !== 'auth_failed',
			rtspReachable,
			httpReachable,
			credentialStatus
		}
	});
});
