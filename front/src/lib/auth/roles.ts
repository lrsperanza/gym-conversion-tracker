import type { Role, User } from '$lib/types';

export const elevatedRoles: Role[] = ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER'];

export const dashboardRoles: Role[] = ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL'];

export function userRoles(user: User | null | undefined): Role[] {
	return user?.roles.map((role) => role.role) ?? [];
}

export function hasElevatedRole(user: User | null | undefined): boolean {
	const roles = userRoles(user);
	return elevatedRoles.some((role) => roles.includes(role));
}

export function isReceptionistOnly(user: User | null | undefined): boolean {
	const roles = userRoles(user);
	return roles.length > 0 && roles.every((role) => role === 'RECEPCIONISTA');
}

export function canAccessAdmin(user: User | null | undefined): boolean {
	return hasElevatedRole(user);
}

export function canAccessDashboard(user: User | null | undefined): boolean {
	const roles = userRoles(user);
	return dashboardRoles.some((role) => roles.includes(role));
}
