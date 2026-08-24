import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const API_ROUTE = '**';

const academy = { id: 'academy-1', name: 'Skyfit Teste', city: 'Araraquara', active: true };
const professor = {
	id: 'prof-1',
	academy_id: 'academy-1',
	name: 'Prof Carlos',
	email: null,
	whatsapp_e164: '+5516999990000',
	active: true
};
const pendingAttendance = {
	id: 'att-1',
	academy_id: 'academy-1',
	lead_id: 'lead-1',
	lead_name: 'Ana',
	lead_email: null,
	whatsapp_e164: null,
	receptionist_name: 'Recepcionista',
	professor_id: null,
	professor_name: null,
	status: 'IN_PROGRESS',
	started_at: '2026-07-29T12:00:00.000Z',
	closed_at: null
};

type ProfessorFixture = {
	id: string;
	academy_id: string;
	name: string;
	email: string | null;
	whatsapp_e164: string | null;
	active: boolean;
};

function sessionUser(roles: Array<{ role: string; academyId: string | null }>) {
	return {
		id: 'user-1',
		name: 'Usuário Teste',
		email: 'teste@example.com',
		roles
	};
}

async function mockSession(page: Page, roles: Array<{ role: string; academyId: string | null }>) {
	await page.route(`${API_ROUTE}/api/auth/me`, async (route) => {
		await route.fulfill({ json: { user: sessionUser(roles) } });
	});
}

function json(route: Route, body: unknown, status = 200) {
	return route.fulfill({ json: body, status });
}

async function mockReferenceData(
	page: Page,
	options: {
		professors?: ProfessorFixture[];
		onCreateProfessor?: (body: Record<string, unknown>) => ProfessorFixture;
	} = {}
) {
	const professorList = options.professors ?? [professor];

	await page.route(`${API_ROUTE}/api/admin/academies`, async (route) => {
		await json(route, { academies: [academy] });
	});
	await page.route(`${API_ROUTE}/api/admin/professors`, async (route) => {
		if (route.request().method() === 'POST' && options.onCreateProfessor) {
			const created = options.onCreateProfessor(route.request().postDataJSON());
			await json(route, { professor: created }, 201);
			return;
		}

		await json(route, { professors: professorList });
	});
	await page.route(`${API_ROUTE}/api/admin/outcome-types`, async (route) => {
		await json(route, { outcomeTypes: [] });
	});
	await page.route(`${API_ROUTE}/api/admin/loss-reasons`, async (route) => {
		await json(route, { lossReasons: [] });
	});
}

async function mockAttendanceData(page: Page) {
	await mockReferenceData(page);
	await page.route(`${API_ROUTE}/api/attendances**`, async (route) => {
		await json(route, { attendances: [] });
	});
}

test('shows the login experience', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/atendimento$/);
	await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Entrar no painel' })).toBeVisible();
});

test('hides administration and redirects direct access for receptionists', async ({ page }) => {
	await mockSession(page, [{ role: 'RECEPCIONISTA', academyId: 'academy-1' }]);
	await mockAttendanceData(page);

	await page.goto('/administracao');

	await expect(page).toHaveURL(/\/atendimento$/);
	await expect(page.getByRole('link', { name: 'Administração' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Novo atendimento' })).toBeVisible();
});

test('shows administration for mixed elevated profiles', async ({ page }) => {
	await mockSession(page, [
		{ role: 'RECEPCIONISTA', academyId: 'academy-1' },
		{ role: 'LIDER', academyId: 'academy-1' }
	]);

	await page.goto('/conta');

	await expect(page.getByRole('link', { name: 'Administração' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Conta' })).toHaveAttribute('aria-current', 'page');
});

test('starts an attendance with only the first name', async ({ page }) => {
	await mockSession(page, [{ role: 'RECEPCIONISTA', academyId: 'academy-1' }]);
	await mockReferenceData(page);

	let createdBody: Record<string, unknown> | null = null;
	await page.route(`${API_ROUTE}/api/attendances**`, async (route) => {
		if (route.request().method() === 'POST') {
			createdBody = route.request().postDataJSON();
			await json(route, { attendance: { ...pendingAttendance, id: 'att-2' } }, 201);
			return;
		}
		await json(route, { attendances: [] });
	});

	await page.goto('/atendimento');
	await page.getByLabel('Primeiro nome').fill('Beatriz');
	await page.getByRole('button', { name: 'Iniciar atendimento' }).click();

	await expect.poll(() => createdBody).not.toBeNull();
	expect(createdBody).toMatchObject({
		academyId: 'academy-1',
		lead: { name: 'Beatriz' },
		presenter: 'RECEPTIONIST',
		status: 'IN_PROGRESS'
	});
	expect((createdBody as unknown as { lead: Record<string, unknown> }).lead).not.toHaveProperty(
		'phone'
	);
});

test('starts an attendance without a name using the placeholder name', async ({ page }) => {
	await mockSession(page, [{ role: 'RECEPCIONISTA', academyId: 'academy-1' }]);
	await mockReferenceData(page);

	let createdBody: Record<string, unknown> | null = null;
	await page.route(`${API_ROUTE}/api/attendances**`, async (route) => {
		if (route.request().method() === 'POST') {
			createdBody = route.request().postDataJSON();
			await json(route, { attendance: { ...pendingAttendance, id: 'att-2' } }, 201);
			return;
		}
		await json(route, { attendances: [] });
	});

	await page.goto('/atendimento');
	await page.getByRole('button', { name: 'Iniciar atendimento' }).click();

	await expect.poll(() => createdBody).not.toBeNull();
	expect(createdBody).toMatchObject({
		lead: { name: 'INSERIR NOME' }
	});
});

test('shows pending chips and saves phone, email and professor independently', async ({ page }) => {
	await mockSession(page, [{ role: 'RECEPCIONISTA', academyId: 'academy-1' }]);
	await mockReferenceData(page);

	const patchCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
	await page.route(`${API_ROUTE}/api/attendances**`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patchCalls.push({
				path: new URL(route.request().url()).pathname,
				body: route.request().postDataJSON()
			});
			await json(route, { attendance: {} });
			return;
		}
		await json(route, { attendances: [pendingAttendance] });
	});
	await page.route(`${API_ROUTE}/api/leads/**`, async (route) => {
		patchCalls.push({
			path: new URL(route.request().url()).pathname,
			body: route.request().postDataJSON()
		});
		await json(route, { lead: {} });
	});

	await page.goto('/atendimento');

	await expect(page.getByRole('button', { name: '+ Número' })).toBeVisible();
	await expect(page.getByRole('button', { name: '+ Email' })).toBeVisible();
	await expect(page.getByRole('button', { name: '+ Professor' })).toBeVisible();

	// Telefone: chip pendente vira input inline e salva sozinho
	await page.getByRole('button', { name: '+ Número' }).click();
	await page.getByPlaceholder('DDD + número (ex.: 16999998888)').fill('16999990001');
	await page.getByRole('button', { name: 'Salvar' }).click();
	await expect.poll(() => patchCalls.length).toBe(1);
	expect(patchCalls[0]).toEqual({
		path: '/api/leads/lead-1',
		body: { phone: { countryCode: '55', areaCode: '16', number: '999990001' } }
	});

	// Email: salva sem depender do telefone
	await page.getByRole('button', { name: '+ Email' }).click();
	await page.getByPlaceholder('email@exemplo.com').fill('ana@example.com');
	await page.getByRole('button', { name: 'Salvar' }).click();
	await expect.poll(() => patchCalls.length).toBe(2);
	expect(patchCalls[1]).toEqual({ path: '/api/leads/lead-1', body: { email: 'ana@example.com' } });

	// Professor: seleção salva na hora
	await page.getByRole('button', { name: '+ Professor' }).click();
	await page
		.locator('select', { has: page.locator('option', { hasText: 'Prof Carlos' }) })
		.selectOption('prof-1');
	await expect.poll(() => patchCalls.length).toBe(3);
	expect(patchCalls[2]).toEqual({
		path: '/api/attendances/att-1',
		body: { professorId: 'prof-1', presenter: 'PROFESSOR' }
	});
});

test('creates a professor from attendance and links it automatically', async ({ page }) => {
	await mockSession(page, [{ role: 'RECEPCIONISTA', academyId: 'academy-1' }]);

	const professorList: ProfessorFixture[] = [professor];
	const createdProfessor: ProfessorFixture = {
		id: 'prof-2',
		academy_id: 'academy-1',
		name: 'Prof Ana',
		email: null,
		whatsapp_e164: null,
		active: true
	};
	let createdBody: Record<string, unknown> | null = null;

	await mockReferenceData(page, {
		professors: professorList,
		onCreateProfessor: (body) => {
			createdBody = body;
			professorList.push(createdProfessor);
			return createdProfessor;
		}
	});

	const patchCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
	await page.route(`${API_ROUTE}/api/attendances**`, async (route) => {
		if (route.request().method() === 'PATCH') {
			patchCalls.push({
				path: new URL(route.request().url()).pathname,
				body: route.request().postDataJSON()
			});
			await json(route, { attendance: {} });
			return;
		}
		await json(route, { attendances: [pendingAttendance] });
	});

	await page.goto('/atendimento');
	await page.getByRole('button', { name: '+ Professor' }).click();
	await page
		.locator('select', { has: page.locator('option', { hasText: 'Cadastrar novo professor' }) })
		.selectOption('__new__');
	await expect(page.getByRole('heading', { name: /Cadastrar professor/ })).toBeVisible();

	await page.locator('dialog').getByLabel('Nome', { exact: true }).fill('Prof Ana');
	await page.getByRole('button', { name: 'Cadastrar professor' }).click();

	await expect.poll(() => createdBody).not.toBeNull();
	expect(createdBody).toMatchObject({
		academyId: 'academy-1',
		name: 'Prof Ana',
		email: null,
		phone: null
	});

	await expect.poll(() => patchCalls.length).toBe(1);
	expect(patchCalls[0]).toEqual({
		path: '/api/attendances/att-1',
		body: { professorId: 'prof-2', presenter: 'PROFESSOR' }
	});
	await expect(
		page.getByText('Professor cadastrado e vinculado ao atendimento.')
	).toBeVisible();
});
