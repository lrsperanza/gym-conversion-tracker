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
	evo_unit_name?: string | null;
	active: boolean;
};

export type Professor = {
	id: string;
	academy_id: string;
	name: string;
	email?: string | null;
	whatsapp_e164?: string | null;
	active: boolean;
};

export type AttendanceEventType =
	| 'LEAD_CREATED'
	| 'TOUR_RECEPTIONIST'
	| 'TOUR_PROFESSOR'
	| 'SALE'
	| 'LOSS'
	| 'EXPERIMENTAL_CLASS_SCHEDULED'
	| 'EXPERIMENTAL_CLASS_NOW'
	| 'FOLLOW_UP_SCHEDULED'
	| 'SCHEDULE_CANCELLED'
	| 'OTHER'
	| 'REOPEN'
	| 'NOTE';

export type LeadEvent = {
	id: string;
	attendance_id: string;
	type: AttendanceEventType;
	scheduled_for?: string | null;
	description?: string | null;
	created_at: string;
	actor_name: string;
	academy_name?: string | null;
	attendance_status: Attendance['status'];
	amount_cents?: number | null;
	label_snapshot?: string | null;
	loss_reason_label?: string | null;
	schedule_cancelled: boolean;
};

export type Attendance = {
	id: string;
	academy_id: string;
	lead_id: string;
	lead_name: string;
	lead_surname?: string | null;
	lead_cpf?: string | null;
	lead_birth_date?: string | null;
	lead_gender?: string | null;
	lead_cep?: string | null;
	lead_visit_type?: string | null;
	lead_how_found_us?: string | null;
	lead_email?: string | null;
	whatsapp_e164?: string | null;
	receptionist_name: string;
	professor_id?: string | null;
	professor_name?: string | null;
	status: 'DRAFT' | 'IN_PROGRESS' | 'PENDING' | 'FINALIZED';
	started_at: string;
	closed_at?: string | null;
	next_event_type?: AttendanceEventType | null;
	next_scheduled_for?: string | null;
	lead_events_count?: number | null;
};

export type LeadSummary = {
	id: string;
	name: string;
	surname?: string | null;
	cpf?: string | null;
	birth_date?: string | null;
	gender?: string | null;
	cep?: string | null;
	visit_type?: string | null;
	how_found_us?: string | null;
	email?: string | null;
	whatsapp_e164?: string | null;
	notes?: string | null;
	created_at: string;
	updated_at: string;
	last_attendance_id?: string | null;
	last_status?: Attendance['status'] | null;
	academy_name?: string | null;
	last_started_at?: string | null;
	next_attendance_id?: string | null;
	next_event_type?: AttendanceEventType | null;
	next_scheduled_for?: string | null;
	events_count?: number | null;
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

export type EvoCredentialsStatus = {
	configured: boolean;
	username: string | null;
};

export type EvoJobStatus = {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	message: string;
	result?: Record<string, string>;
	error?: string;
	screenshot?: string;
	createdAt: string;
	updatedAt: string;
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
