import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const API_URL = 'http://localhost:3000';

function sessionUser(roles: Array<{ role: string; academyId: string | null }>) {
	return {
		id: 'user-1',
		name: 'Usuário Teste',
		email: 'teste@example.com',
		roles
	};
}

async function mockSession(page: Page, roles: Array<{ role: string; academyId: string | null }>) {
	await page.route(`${API_URL}/api/auth/me`, async (route) => {
		await route.fulfill({ json: { user: sessionUser(roles) } });
	});
}

async function mockAttendanceData(page: Page) {
	await page.route(`${API_URL}/api/admin/academies`, async (route) => {
		await route.fulfill({ json: { academies: [] } });
	});
	await page.route(`${API_URL}/api/admin/professors`, async (route) => {
		await route.fulfill({ json: { professors: [] } });
	});
	await page.route(`${API_URL}/api/admin/outcome-types`, async (route) => {
		await route.fulfill({ json: { outcomeTypes: [] } });
	});
	await page.route(`${API_URL}/api/admin/loss-reasons`, async (route) => {
		await route.fulfill({ json: { lossReasons: [] } });
	});
	await page.route(`${API_URL}/api/attendances**`, async (route) => {
		await route.fulfill({ json: { attendances: [] } });
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
