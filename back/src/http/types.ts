export type Role = 'ADMIN' | 'SOCIO' | 'GERENTE_REGIONAL' | 'LIDER' | 'RECEPCIONISTA';

export type SessionUser = {
	id: string;
	name: string;
	email: string;
	active: boolean;
	roles: Array<{ role: Role; academyId: string | null }>;
};

export type AppBindings = {
	Variables: {
		user: SessionUser;
		sessionId: string;
	};
};

