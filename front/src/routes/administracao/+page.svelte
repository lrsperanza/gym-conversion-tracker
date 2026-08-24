<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api } from '$lib/api/client';
	import { canAccessAdmin } from '$lib/auth/roles';
	import Notice from '$lib/components/Notice.svelte';
	import { asCents, errorMessage, roleLabel } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type {
		Academy,
		AcademyDvr,
		AdminCamera,
		DvrTestResult,
		LossReason,
		OutcomeType,
		Professor,
		Role,
		User
	} from '$lib/types';
	import { onMount } from 'svelte';

	type AdminUser = User & { active?: boolean; whatsapp_e164?: string | null };
	type OutcomeDraft = {
		label: string;
		currentValue: string;
		requiresManualValue: boolean;
		active: boolean;
	};
	type LossReasonDraft = {
		label: string;
		category: string;
		requiresDescription: boolean;
		active: boolean;
	};

	const roleOptions: Role[] = ['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER', 'RECEPCIONISTA'];
	const defaultUserForm = {
		name: '',
		email: '',
		countryCode: '55',
		areaCode: '16',
		number: '',
		password: '',
		role: 'RECEPCIONISTA' as Role,
		academyId: ''
	};
	const lossCategories = ['APPROACH', 'PRICE', 'STRUCTURE', 'LEAD_QUALITY', 'SCHEDULE_MODALITY'];
	const { session } = getSessionContext();

	let academies = $state.raw<Academy[]>([]);
	let users = $state.raw<AdminUser[]>([]);
	let professors = $state.raw<Professor[]>([]);
	let outcomeTypes = $state.raw<OutcomeType[]>([]);
	let lossReasons = $state.raw<LossReason[]>([]);
	let adminLoading = $state(false);
	let adminMessage = $state('');
	let adminSavingId = $state('');
	let userCreating = $state(false);
	let academyForm = $state({ id: '', name: '', city: '', evoUnitName: '', active: true });
	let userForm = $state({ ...defaultUserForm });
	let professorForm = $state({
		academyId: '',
		name: '',
		email: '',
		countryCode: '55',
		areaCode: '16',
		number: ''
	});
	let outcomeDrafts = $state<Record<string, OutcomeDraft>>({});
	let lossReasonDrafts = $state<Record<string, LossReasonDraft>>({});
	let outcomeForm = $state<OutcomeDraft>({
		label: '',
		currentValue: '',
		requiresManualValue: false,
		active: true
	});
	let lossForm = $state({
		label: '',
		category: 'APPROACH',
		requiresDescription: false,
		active: true
	});
	let activeAcademies = $derived(academies.filter((academy) => academy.active));

	let cameraAcademyId = $state('');
	let dvrs = $state.raw<AcademyDvr[]>([]);
	let dvrForm = $state({
		id: '',
		name: '',
		host: '',
		rtspPort: 554,
		httpPort: 80,
		username: '',
		password: '',
		active: true
	});
	let dvrTestMessages = $state<Record<string, string>>({});
	let dvrTestOk = $state<Record<string, boolean>>({});
	let dvrTesting = $state<Record<string, boolean>>({});
	let cameraDrafts = $state<Record<string, { name: string; channel: number; isDefault: boolean }>>(
		{}
	);

	onMount(() => {
		if (!session.user) return;
		if (!canAccessAdmin(session.user)) {
			void goto(resolve('/atendimento'), { replaceState: true });
			return;
		}
		void loadAdminData();
	});

	async function loadUsers() {
		if (!session.user || !canAccessAdmin(session.user)) return;
		const data = await api<{ users: AdminUser[] }>('/api/admin/users');
		users = data.users;
	}

	async function loadAdminData() {
		if (!session.user || !canAccessAdmin(session.user)) return;
		adminLoading = true;
		adminMessage = '';
		try {
			const [academyData, userData, professorData, outcomeData, lossData] = await Promise.all([
				api<{ academies: Academy[] }>('/api/admin/academies'),
				api<{ users: AdminUser[] }>('/api/admin/users'),
				api<{ professors: Professor[] }>('/api/admin/professors'),
				api<{ outcomeTypes: OutcomeType[] }>('/api/admin/outcome-types'),
				api<{ lossReasons: LossReason[] }>('/api/admin/loss-reasons')
			]);
			academies = academyData.academies;
			users = userData.users;
			professors = professorData.professors;
			outcomeTypes = outcomeData.outcomeTypes;
			lossReasons = lossData.lossReasons;
			outcomeDrafts = Object.fromEntries(
				outcomeTypes.map((outcome) => [outcome.id, outcomeDraft(outcome)])
			);
			lossReasonDrafts = Object.fromEntries(
				lossReasons.map((reason) => [reason.id, lossReasonDraft(reason)])
			);
			if (!professorForm.academyId && activeAcademies[0])
				professorForm.academyId = activeAcademies[0].id;
			if (!cameraAcademyId && activeAcademies[0]) cameraAcademyId = activeAcademies[0].id;
			if (cameraAcademyId) await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			adminLoading = false;
		}
	}

	async function saveAcademy(event: SubmitEvent) {
		event.preventDefault();
		adminMessage = '';
		try {
			const payload = {
				name: academyForm.name,
				city: academyForm.city || null,
				evoUnitName: academyForm.evoUnitName || null,
				active: academyForm.active
			};
			if (academyForm.id) {
				await api<{ academy: Academy }>(`/api/admin/academies/${academyForm.id}`, {
					method: 'PATCH',
					body: JSON.stringify(payload)
				});
				adminMessage = 'Academia atualizada.';
			} else {
				await api<{ academy: Academy }>('/api/admin/academies', {
					method: 'POST',
					body: JSON.stringify(payload)
				});
				adminMessage = 'Academia criada.';
			}
			academyForm = { id: '', name: '', city: '', evoUnitName: '', active: true };
			await loadAdminData();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	function editAcademy(academy: Academy) {
		academyForm = {
			id: academy.id,
			name: academy.name,
			city: academy.city ?? '',
			evoUnitName: academy.evo_unit_name ?? '',
			active: academy.active
		};
	}

	async function createUser(event: SubmitEvent) {
		event.preventDefault();
		adminMessage = '';
		userCreating = true;
		try {
			const academyId =
				userForm.role === 'ADMIN' || userForm.role === 'SOCIO' ? null : userForm.academyId;
			const data = await api<{
				user: AdminUser;
				temporaryPassword?: string;
				confirmationEmailSent: boolean;
			}>('/api/admin/users', {
				method: 'POST',
				body: JSON.stringify({
					name: userForm.name,
					email: userForm.email,
					phone: {
						countryCode: userForm.countryCode,
						areaCode: userForm.areaCode,
						number: userForm.number
					},
					password: userForm.password || undefined,
					roles: [{ role: userForm.role, academyId }]
				})
			});
			const createdMessage = data.temporaryPassword
				? `Usuário criado. Senha temporária: ${data.temporaryPassword}`
				: 'Usuário criado e email de confirmação enviado.';
			adminMessage = data.confirmationEmailSent
				? createdMessage
				: `${createdMessage.replace(' e email de confirmação enviado', '')} O email de confirmação não pôde ser enviado; revise a configuração SMTP.`;
			userForm = { ...defaultUserForm };
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			try {
				await loadUsers();
			} catch (error) {
				const refreshMessage = `Não foi possível atualizar a lista de usuários: ${errorMessage(error)}`;
				adminMessage = adminMessage ? `${adminMessage} ${refreshMessage}` : refreshMessage;
			}
			userCreating = false;
		}
	}

	async function toggleUser(user: AdminUser) {
		adminMessage = '';
		try {
			await api<{ user: AdminUser }>(`/api/admin/users/${user.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ active: !user.active })
			});
			adminMessage = 'Status do usuário atualizado.';
			await loadAdminData();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function createProfessor(event: SubmitEvent) {
		event.preventDefault();
		adminMessage = '';
		try {
			await api<{ professor: Professor }>('/api/admin/professors', {
				method: 'POST',
				body: JSON.stringify({
					academyId: professorForm.academyId,
					name: professorForm.name,
					email: professorForm.email || null,
					phone: {
						countryCode: professorForm.countryCode,
						areaCode: professorForm.areaCode,
						number: professorForm.number
					}
				})
			});
			adminMessage = 'Professor criado.';
			professorForm.name = '';
			professorForm.email = '';
			professorForm.number = '';
			await loadAdminData();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function toggleProfessor(professor: Professor) {
		adminMessage = '';
		try {
			await api<{ professor: Professor }>(`/api/admin/professors/${professor.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ active: !professor.active })
			});
			adminMessage = 'Status do professor atualizado.';
			await loadAdminData();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function loadDvrs() {
		if (!cameraAcademyId) {
			dvrs = [];
			return;
		}
		const data = await api<{ dvrs: AcademyDvr[] }>(`/api/admin/academies/${cameraAcademyId}/dvrs`);
		dvrs = data.dvrs;
		cameraDrafts = Object.fromEntries(
			data.dvrs.map((dvr) => [
				dvr.id,
				cameraDrafts[dvr.id] ?? { name: '', channel: 1, isDefault: false }
			])
		);
	}

	async function changeCameraAcademy() {
		adminMessage = '';
		dvrTestMessages = {};
		dvrTestOk = {};
		resetDvrForm();
		try {
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	function resetDvrForm() {
		dvrForm = {
			id: '',
			name: '',
			host: '',
			rtspPort: 554,
			httpPort: 80,
			username: '',
			password: '',
			active: true
		};
	}

	function editDvr(dvr: AcademyDvr) {
		dvrForm = {
			id: dvr.id,
			name: dvr.name,
			host: dvr.host,
			rtspPort: dvr.rtspPort,
			httpPort: dvr.httpPort,
			username: dvr.username,
			password: '',
			active: dvr.active
		};
	}

	async function saveDvr(event: SubmitEvent) {
		event.preventDefault();
		if (!cameraAcademyId) return;
		adminMessage = '';
		try {
			const payload: {
				name: string;
				host: string;
				rtspPort: number;
				httpPort: number;
				username: string;
				active: boolean;
				password?: string;
			} = {
				name: dvrForm.name,
				host: dvrForm.host,
				rtspPort: dvrForm.rtspPort,
				httpPort: dvrForm.httpPort,
				username: dvrForm.username,
				active: dvrForm.active
			};
			if (dvrForm.id) {
				if (dvrForm.password) payload.password = dvrForm.password;
				await api<{ dvr: AcademyDvr }>(`/api/admin/dvrs/${dvrForm.id}`, {
					method: 'PATCH',
					body: JSON.stringify(payload)
				});
				adminMessage = 'DVR atualizado.';
			} else {
				payload.password = dvrForm.password;
				await api<{ dvr: AcademyDvr }>(`/api/admin/academies/${cameraAcademyId}/dvrs`, {
					method: 'POST',
					body: JSON.stringify(payload)
				});
				adminMessage = 'DVR criado.';
			}
			resetDvrForm();
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function toggleDvr(dvr: AcademyDvr) {
		adminMessage = '';
		try {
			if (dvr.active) {
				await api<{ ok: boolean }>(`/api/admin/dvrs/${dvr.id}`, { method: 'DELETE' });
				adminMessage = 'DVR inativado.';
			} else {
				await api<{ dvr: AcademyDvr }>(`/api/admin/dvrs/${dvr.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ active: true })
				});
				adminMessage = 'DVR reativado.';
			}
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	function dvrTestMessage(result: DvrTestResult) {
		if (result.ok) return 'RTSP ok · credenciais ok';
		const problems: string[] = [];
		if (!result.rtspReachable) problems.push('RTSP inacessível');
		if (result.credentialStatus === 'auth_failed') problems.push('credenciais recusadas');
		else if (result.credentialStatus === 'unreachable')
			problems.push('DVR inacessível (verifique o Tailscale)');
		else if (result.credentialStatus === 'unsupported') problems.push('API HTTP não suportada');
		return problems.length ? problems.join(' · ') : 'Falha no teste do DVR.';
	}

	async function testDvr(dvr: AcademyDvr) {
		adminMessage = '';
		dvrTesting[dvr.id] = true;
		try {
			const data = await api<{ result: DvrTestResult }>(`/api/admin/dvrs/${dvr.id}/test`, {
				method: 'POST'
			});
			dvrTestOk[dvr.id] = data.result.ok;
			dvrTestMessages[dvr.id] = dvrTestMessage(data.result);
		} catch (error) {
			dvrTestOk[dvr.id] = false;
			dvrTestMessages[dvr.id] = errorMessage(error);
		} finally {
			dvrTesting[dvr.id] = false;
		}
	}

	async function setCameraDefault(camera: AdminCamera) {
		adminMessage = '';
		try {
			await api<{ camera: AdminCamera }>(`/api/admin/cameras/${camera.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ isDefault: true })
			});
			adminMessage = 'Câmera padrão atualizada.';
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function toggleCamera(camera: AdminCamera) {
		adminMessage = '';
		try {
			if (camera.active) {
				await api<{ ok: boolean }>(`/api/admin/cameras/${camera.id}`, { method: 'DELETE' });
				adminMessage = 'Câmera inativada.';
			} else {
				await api<{ camera: AdminCamera }>(`/api/admin/cameras/${camera.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ active: true })
				});
				adminMessage = 'Câmera reativada.';
			}
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	async function createCamera(event: SubmitEvent, dvr: AcademyDvr) {
		event.preventDefault();
		const draft = cameraDrafts[dvr.id];
		if (!draft) return;
		adminMessage = '';
		try {
			await api<{ camera: AdminCamera }>(`/api/admin/dvrs/${dvr.id}/cameras`, {
				method: 'POST',
				body: JSON.stringify({
					name: draft.name,
					channel: draft.channel,
					isDefault: draft.isDefault
				})
			});
			adminMessage = 'Câmera adicionada.';
			cameraDrafts[dvr.id] = { name: '', channel: 1, isDefault: false };
			await loadDvrs();
		} catch (error) {
			adminMessage = errorMessage(error);
		}
	}

	function outcomeDraft(outcome: OutcomeType): OutcomeDraft {
		return {
			label: outcome.label,
			currentValue:
				outcome.current_value_cents === null || outcome.current_value_cents === undefined
					? ''
					: String(outcome.current_value_cents / 100).replace('.', ','),
			requiresManualValue: outcome.requires_manual_value,
			active: outcome.active
		};
	}

	function lossReasonDraft(reason: LossReason): LossReasonDraft {
		return {
			label: reason.label,
			category: reason.category,
			requiresDescription: reason.requires_description,
			active: reason.active
		};
	}

	function outcomeChanged(outcome: OutcomeType) {
		const draft = outcomeDrafts[outcome.id];
		if (!draft) return false;
		const original = outcomeDraft(outcome);
		return (
			draft.label !== original.label ||
			draft.currentValue !== original.currentValue ||
			draft.requiresManualValue !== original.requiresManualValue ||
			draft.active !== original.active
		);
	}

	function lossReasonChanged(reason: LossReason) {
		const draft = lossReasonDrafts[reason.id];
		if (!draft) return false;
		const original = lossReasonDraft(reason);
		return (
			draft.label !== original.label ||
			draft.category !== original.category ||
			draft.requiresDescription !== original.requiresDescription ||
			draft.active !== original.active
		);
	}

	async function createOutcome(event: SubmitEvent) {
		event.preventDefault();
		adminMessage = '';
		adminSavingId = 'new-outcome';
		try {
			const data = await api<{ outcomeType: OutcomeType }>('/api/admin/outcome-types', {
				method: 'POST',
				body: JSON.stringify({
					label: outcomeForm.label,
					currentValueCents: asCents(outcomeForm.currentValue) ?? null,
					requiresManualValue: outcomeForm.requiresManualValue,
					active: outcomeForm.active
				})
			});
			outcomeTypes = [...outcomeTypes, data.outcomeType].sort((a, b) =>
				a.label.localeCompare(b.label, 'pt-BR')
			);
			outcomeDrafts[data.outcomeType.id] = outcomeDraft(data.outcomeType);
			outcomeForm = { label: '', currentValue: '', requiresManualValue: false, active: true };
			adminMessage = 'Plano criado.';
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			adminSavingId = '';
		}
	}

	async function updateOutcome(outcome: OutcomeType) {
		const draft = outcomeDrafts[outcome.id];
		if (!draft) return;
		adminMessage = '';
		adminSavingId = outcome.id;
		try {
			const data = await api<{ outcomeType: OutcomeType }>(
				`/api/admin/outcome-types/${outcome.id}`,
				{
					method: 'PATCH',
					body: JSON.stringify({
						label: draft.label,
						currentValueCents: asCents(draft.currentValue) ?? null,
						requiresManualValue: draft.requiresManualValue,
						active: draft.active
					})
				}
			);
			outcomeTypes = outcomeTypes.map((item) => (item.id === outcome.id ? data.outcomeType : item));
			outcomeDrafts[outcome.id] = outcomeDraft(data.outcomeType);
			adminMessage = 'Plano atualizado.';
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			adminSavingId = '';
		}
	}

	async function updateLossReason(reason: LossReason) {
		const draft = lossReasonDrafts[reason.id];
		if (!draft) return;
		adminMessage = '';
		adminSavingId = reason.id;
		try {
			const data = await api<{ lossReason: LossReason }>(`/api/admin/loss-reasons/${reason.id}`, {
				method: 'PATCH',
				body: JSON.stringify({
					label: draft.label,
					category: draft.category,
					requiresDescription: draft.requiresDescription,
					active: draft.active
				})
			});
			lossReasons = lossReasons.map((item) => (item.id === reason.id ? data.lossReason : item));
			lossReasonDrafts[reason.id] = lossReasonDraft(data.lossReason);
			adminMessage = 'Motivo de perda atualizado.';
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			adminSavingId = '';
		}
	}

	async function createLossReason(event: SubmitEvent) {
		event.preventDefault();
		adminMessage = '';
		adminSavingId = 'new-loss-reason';
		try {
			const data = await api<{ lossReason: LossReason }>('/api/admin/loss-reasons', {
				method: 'POST',
				body: JSON.stringify({
					label: lossForm.label,
					category: lossForm.category,
					requiresDescription: lossForm.requiresDescription,
					active: lossForm.active
				})
			});
			lossReasons = [...lossReasons, data.lossReason].sort((a, b) =>
				a.label.localeCompare(b.label, 'pt-BR')
			);
			lossReasonDrafts[data.lossReason.id] = lossReasonDraft(data.lossReason);
			lossForm = { label: '', category: 'APPROACH', requiresDescription: false, active: true };
			adminMessage = 'Motivo de perda criado.';
		} catch (error) {
			adminMessage = errorMessage(error);
		} finally {
			adminSavingId = '';
		}
	}
</script>

<svelte:head>
	<title>Administração | Tracker de conversão</title>
</svelte:head>

{#if session.user && canAccessAdmin(session.user)}
	<section class="space-y-6">
		<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<h2 class="text-2xl font-bold text-slate-950">Administração</h2>
			<p class="text-slate-600">
				Cadastros compactos para academias, usuários, professores, planos e perdas.
			</p>
			<div class="mt-4 flex gap-3">
				<button
					class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
					onclick={loadAdminData}
					disabled={adminLoading}
				>
					Recarregar dados
				</button>
			</div>
		</div>
		<Notice message={adminMessage} />

		<div class="grid gap-6 xl:grid-cols-2">
			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-lg font-bold text-slate-950">Academias</h3>
				<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={saveAcademy}>
					<label class="text-sm font-medium text-slate-700"
						>Nome<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={academyForm.name}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>Cidade<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={academyForm.city}
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>Unidade no EVO<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={academyForm.evoUnitName}
						/></label
					>
					<label class="flex items-center gap-2 text-sm font-medium text-slate-700"
						><input
							class="rounded border-slate-300"
							type="checkbox"
							bind:checked={academyForm.active}
						/>Ativa</label
					>
					<button class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white"
						>{academyForm.id ? 'Atualizar' : 'Criar'} academia</button
					>
				</form>
				<div class="mt-4 grid gap-2">
					{#each academies as academy (academy.id)}
						<div class="flex items-center justify-between rounded-2xl border border-slate-200 p-3">
							<p class="text-sm">
								<strong>{academy.name}</strong><br />{academy.city ?? 'Sem cidade'} · {academy.active
									? 'Ativa'
									: 'Inativa'}{academy.evo_unit_name ? ` · EVO: ${academy.evo_unit_name}` : ''}
							</p>
							<button
								class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
								onclick={() => editAcademy(academy)}>Editar</button
							>
						</div>
					{/each}
				</div>
			</section>

			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-lg font-bold text-slate-950">Usuários</h3>
				<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={createUser}>
					<label class="text-sm font-medium text-slate-700"
						>Nome<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={userForm.name}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>Email<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="email"
							bind:value={userForm.email}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700">
						Perfil
						<select class="mt-1 w-full rounded-2xl border-slate-300" bind:value={userForm.role}>
							{#each roleOptions as role (role)}
								<option value={role}>{roleLabel(role)}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Academia
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={userForm.academyId}
						>
							<option value="">Global / sem unidade</option>
							{#each academies as academy (academy.id)}
								<option value={academy.id}>{academy.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700"
						>DDD<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={userForm.areaCode}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>WhatsApp<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={userForm.number}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700 sm:col-span-2"
						>Senha inicial opcional<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="password"
							bind:value={userForm.password}
							minlength="8"
						/></label
					>
					<button
						class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2"
						disabled={userCreating}
					>
						{userCreating ? 'Criando usuário...' : 'Criar usuário'}
					</button>
				</form>
				<div class="mt-4 max-h-72 space-y-2 overflow-auto">
					{#each users as user (user.id)}
						<div
							class="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3"
						>
							<p class="text-sm">
								<strong>{user.name}</strong><br />{user.email} · {user.roles
									.map((role) => roleLabel(role.role))
									.join(', ') || 'Sem perfil'}
							</p>
							<button
								class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
								onclick={() => toggleUser(user)}
								>{user.active === false ? 'Ativar' : 'Inativar'}</button
							>
						</div>
					{/each}
				</div>
			</section>

			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-lg font-bold text-slate-950">Professores</h3>
				<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={createProfessor}>
					<label class="text-sm font-medium text-slate-700">
						Academia
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={professorForm.academyId}
							required
						>
							<option value="" disabled>Selecione</option>
							{#each academies as academy (academy.id)}
								<option value={academy.id}>{academy.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700"
						>Nome<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={professorForm.name}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>Email opcional<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="email"
							bind:value={professorForm.email}
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>WhatsApp<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={professorForm.number}
							required
						/></label
					>
					<button class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white sm:col-span-2"
						>Criar professor</button
					>
				</form>
				<div class="mt-4 max-h-72 space-y-2 overflow-auto">
					{#each professors as professor (professor.id)}
						<div class="flex items-center justify-between rounded-2xl border border-slate-200 p-3">
							<p class="text-sm">
								<strong>{professor.name}</strong><br />{professor.email ?? 'Sem email'} · {professor.active
									? 'Ativo'
									: 'Inativo'}
							</p>
							<button
								class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
								onclick={() => toggleProfessor(professor)}
								>{professor.active ? 'Inativar' : 'Ativar'}</button
							>
						</div>
					{/each}
				</div>
			</section>

			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-lg font-bold text-slate-950">Câmeras e DVRs</h3>
				<p class="mt-1 text-sm text-slate-600">
					Configura o DVR Intelbras de cada academia, usado para revisar as gravações das vendas.
				</p>
				<label class="mt-4 block text-sm font-medium text-slate-700">
					Academia
					<select
						class="mt-1 w-full rounded-2xl border-slate-300"
						bind:value={cameraAcademyId}
						onchange={() => void changeCameraAcademy()}
					>
						<option value="" disabled>Selecione</option>
						{#each academies as academy (academy.id)}
							<option value={academy.id}>{academy.name}</option>
						{/each}
					</select>
				</label>
				{#if cameraAcademyId}
					<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={saveDvr}>
						<label class="text-sm font-medium text-slate-700"
							>Nome<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								bind:value={dvrForm.name}
								required
							/></label
						>
						<label class="text-sm font-medium text-slate-700"
							>Host<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								placeholder="192.168.1.191 ou 100.x.y.z"
								bind:value={dvrForm.host}
								required
							/></label
						>
						<label class="text-sm font-medium text-slate-700"
							>Porta RTSP<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								type="number"
								min="1"
								max="65535"
								bind:value={dvrForm.rtspPort}
								required
							/></label
						>
						<label class="text-sm font-medium text-slate-700"
							>Porta HTTP<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								type="number"
								min="1"
								max="65535"
								bind:value={dvrForm.httpPort}
								required
							/></label
						>
						<label class="text-sm font-medium text-slate-700"
							>Usuário<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								bind:value={dvrForm.username}
								required
							/></label
						>
						<label class="text-sm font-medium text-slate-700"
							>Senha<input
								class="mt-1 w-full rounded-2xl border-slate-300"
								type="password"
								placeholder={dvrForm.id ? 'deixe em branco para manter' : ''}
								bind:value={dvrForm.password}
								required={!dvrForm.id}
							/></label
						>
						<label class="flex items-center gap-2 text-sm font-medium text-slate-700"
							><input
								class="rounded border-slate-300"
								type="checkbox"
								bind:checked={dvrForm.active}
							/>Ativo</label
						>
						<div class="flex gap-2 sm:col-span-2">
							<button class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white"
								>{dvrForm.id ? 'Atualizar' : 'Criar'} DVR</button
							>
							{#if dvrForm.id}
								<button
									type="button"
									class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
									onclick={resetDvrForm}>Cancelar edição</button
								>
							{/if}
						</div>
					</form>
					<div class="mt-4 space-y-3">
						{#each dvrs as dvr (dvr.id)}
							{@const cameraDraft = cameraDrafts[dvr.id]}
							<div class="rounded-2xl border border-slate-200 p-3">
								<div class="flex items-center justify-between gap-3">
									<p class="text-sm">
										<strong>{dvr.name}</strong>
										<span
											class={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${dvr.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}
											>{dvr.active ? 'Ativo' : 'Inativo'}</span
										><br />
										{dvr.host}:{dvr.rtspPort} · usuário {dvr.username}
									</p>
									<div class="flex gap-2">
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40"
											onclick={() => testDvr(dvr)}
											disabled={dvrTesting[dvr.id]}
											>{dvrTesting[dvr.id] ? 'Testando...' : 'Testar'}</button
										>
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
											onclick={() => editDvr(dvr)}>Editar</button
										>
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
											onclick={() => toggleDvr(dvr)}>{dvr.active ? 'Inativar' : 'Ativar'}</button
										>
									</div>
								</div>
								{#if dvrTestMessages[dvr.id]}
									<p
										class={`mt-2 text-xs ${dvrTestOk[dvr.id] ? 'text-emerald-600' : 'text-red-600'}`}
									>
										{dvrTestMessages[dvr.id]}
									</p>
								{/if}
								<div class="mt-3 space-y-2 border-t border-slate-100 pt-3">
									{#each dvr.cameras ?? [] as camera (camera.id)}
										<div
											class={`flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-2 ${camera.active ? '' : 'opacity-60'}`}
										>
											<p class="text-sm">
												<strong>{camera.name}</strong> · canal {camera.channel}
												{#if camera.isDefault}
													<span
														class="ml-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700"
														>padrão</span
													>
												{/if}
												{#if !camera.active}
													<span class="ml-1 text-xs text-slate-500">Inativa</span>
												{/if}
											</p>
											<div class="flex gap-2">
												{#if camera.active && !camera.isDefault}
													<button
														type="button"
														class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
														onclick={() => setCameraDefault(camera)}>Tornar padrão</button
													>
												{/if}
												<button
													type="button"
													class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
													onclick={() => toggleCamera(camera)}
													>{camera.active ? 'Inativar' : 'Ativar'}</button
												>
											</div>
										</div>
									{/each}
									{#if cameraDraft}
										<form
											class="grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1fr_7rem_auto_auto]"
											onsubmit={(event) => createCamera(event, dvr)}
										>
											<input
												class="rounded-xl border-slate-300"
												placeholder="Nome da câmera"
												bind:value={cameraDraft.name}
												required
											/>
											<input
												class="rounded-xl border-slate-300"
												type="number"
												min="1"
												placeholder="Canal"
												bind:value={cameraDraft.channel}
												required
											/>
											<label class="flex items-center gap-2 text-sm font-medium"
												><input type="checkbox" bind:checked={cameraDraft.isDefault} /> Padrão</label
											>
											<button
												class="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
												>Adicionar</button
											>
										</form>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-lg font-bold text-slate-950">Planos e motivos de perda</h3>
				<div class="mt-5 space-y-3">
					<h4 class="font-semibold text-slate-900">Planos</h4>
					{#each outcomeTypes as outcome (outcome.id)}
						{@const draft = outcomeDrafts[outcome.id]}
						{#if draft}
							<div
								class={`grid gap-3 rounded-2xl border border-slate-200 p-3 sm:grid-cols-[1fr_8rem_auto_auto_auto] ${outcomeChanged(outcome) ? 'bg-sky-50' : ''}`}
							>
								<input
									class="rounded-xl border-slate-300"
									bind:value={draft.label}
									minlength="2"
									required
								/>
								<input
									class="rounded-xl border-slate-300"
									inputmode="decimal"
									placeholder="0,00"
									bind:value={draft.currentValue}
								/>
								<label class="flex items-center gap-2 text-sm font-medium"
									><input type="checkbox" bind:checked={draft.requiresManualValue} /> Manual</label
								>
								<label class="flex items-center gap-2 text-sm font-medium"
									><input type="checkbox" bind:checked={draft.active} />
									{draft.active ? 'Ativo' : 'Inativo'}</label
								>
								<button
									type="button"
									class="rounded-xl bg-slate-950 px-3 py-2 font-semibold text-white disabled:opacity-40"
									onclick={() => updateOutcome(outcome)}
									disabled={!outcomeChanged(outcome) ||
										adminSavingId === outcome.id ||
										draft.label.trim().length < 2}>Salvar</button
								>
							</div>
						{/if}
					{/each}
				</div>
				<form class="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4" onsubmit={createOutcome}>
					<h4 class="font-semibold text-slate-900">Adicionar plano</h4>
					<input
						class="rounded-2xl border-slate-300"
						placeholder="Rótulo"
						bind:value={outcomeForm.label}
						minlength="2"
						required
					/>
					<input
						class="rounded-2xl border-slate-300"
						inputmode="decimal"
						placeholder="Valor R$ opcional"
						bind:value={outcomeForm.currentValue}
					/>
					<label class="flex items-center gap-2 text-sm font-medium"
						><input type="checkbox" bind:checked={outcomeForm.requiresManualValue} /> Valor manual</label
					>
					<label class="flex items-center gap-2 text-sm font-medium"
						><input type="checkbox" bind:checked={outcomeForm.active} /> Ativo</label
					>
					<button
						class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white disabled:opacity-50"
						disabled={adminSavingId === 'new-outcome' || outcomeForm.label.trim().length < 2}
						>Criar plano</button
					>
				</form>
				<div class="mt-7 space-y-3 border-t border-slate-200 pt-5">
					<h4 class="font-semibold text-slate-900">Motivos de perda</h4>
					{#each lossReasons as reason (reason.id)}
						{@const draft = lossReasonDrafts[reason.id]}
						{#if draft}
							<div
								class={`grid gap-3 rounded-2xl border border-slate-200 p-3 sm:grid-cols-[1fr_12rem_auto_auto_auto] ${lossReasonChanged(reason) ? 'bg-sky-50' : ''}`}
							>
								<input
									class="rounded-xl border-slate-300"
									bind:value={draft.label}
									minlength="2"
									required
								/>
								<select class="rounded-xl border-slate-300" bind:value={draft.category}>
									{#each lossCategories as category (category)}
										<option value={category}>{category}</option>
									{/each}
								</select>
								<label class="flex items-center gap-2 text-sm font-medium"
									><input type="checkbox" bind:checked={draft.requiresDescription} /> Descrição</label
								>
								<label class="flex items-center gap-2 text-sm font-medium"
									><input type="checkbox" bind:checked={draft.active} />
									{draft.active ? 'Ativo' : 'Inativo'}</label
								>
								<button
									type="button"
									class="rounded-xl bg-slate-950 px-3 py-2 font-semibold text-white disabled:opacity-40"
									onclick={() => updateLossReason(reason)}
									disabled={!lossReasonChanged(reason) ||
										adminSavingId === reason.id ||
										draft.label.trim().length < 2}>Salvar</button
								>
							</div>
						{/if}
					{/each}
				</div>
				<form class="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-4" onsubmit={createLossReason}>
					<h4 class="font-semibold text-slate-900">Adicionar motivo de perda</h4>
					<input
						class="rounded-2xl border-slate-300"
						placeholder="Rótulo"
						bind:value={lossForm.label}
						minlength="2"
						required
					/>
					<select class="rounded-2xl border-slate-300" bind:value={lossForm.category}>
						{#each lossCategories as category (category)}
							<option value={category}>{category}</option>
						{/each}
					</select>
					<label class="flex items-center gap-2 text-sm font-medium"
						><input type="checkbox" bind:checked={lossForm.requiresDescription} /> Exige descrição</label
					>
					<label class="flex items-center gap-2 text-sm font-medium"
						><input type="checkbox" bind:checked={lossForm.active} /> Ativo</label
					>
					<button
						class="rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white disabled:opacity-50"
						disabled={adminSavingId === 'new-loss-reason'}>Criar motivo</button
					>
				</form>
			</section>
		</div>
	</section>
{:else}
	<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
		<h2 class="text-2xl font-bold text-slate-950">Redirecionando...</h2>
		<p class="text-slate-600">Seu perfil não tem acesso à administração.</p>
	</section>
{/if}
