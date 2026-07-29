export type Role = 'ADMIN' | 'SOCIO' | 'GERENTE_REGIONAL' | 'LIDER' | 'RECEPCIONISTA';

export type User = {
	id: string;
	name: string;
	email: string;
	roles: Array<{ role: Role; academyId: string | null }>;
};

export type Academy = {
	id: string;
	name: string;
	city?: string | null;
	active: boolean;
};

export type Professor = {
	id: string;
	academy_id: string;
	name: string;
	email?: string | null;
	whatsapp_e164: string;
	active: boolean;
};

export type Attendance = {
	id: string;
	academy_id: string;
	lead_id: string;
	lead_name: string;
	lead_email?: string | null;
	whatsapp_e164?: string | null;
	receptionist_name: string;
	professor_id?: string | null;
	professor_name?: string | null;
	status: 'DRAFT' | 'IN_PROGRESS' | 'PENDING' | 'FINALIZED';
	started_at: string;
	closed_at?: string | null;
};

export type OutcomeType = {
	id: string;
	key: string;
	label: string;
	current_value_cents: number | null;
	requires_manual_value: boolean;
	active: boolean;
};

export type LossReason = {
	id: string;
	label: string;
	category: string;
	requires_description: boolean;
	active: boolean;
};

export type DashboardSummary = {
	kpi: {
		attendances: number;
		converted: number;
		revenue_cents: number;
		conversionRate: number;
	};
	receptionists: MetricRow[];
	professors: MetricRow[];
	pairs: Array<
		MetricRow & {
			receptionist_name: string;
			professor_name: string;
			professor_global_conversion_rate: number;
		}
	>;
	closers: Array<{ id: string; name: string; sales: number; revenue_cents: number }>;
	timeline: MetricRow[];
};

export type MetricRow = {
	id?: string;
	name?: string;
	day?: string;
	attendances: number;
	converted: number;
	revenue_cents: number;
	conversionRate: number;
};
