<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { ApiError, api } from '$lib/api/client';
	import { canAccessAdmin } from '$lib/auth/roles';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage } from '$lib/helpers';
	import { setSessionContext, type SessionState } from '$lib/session';
	import type { User } from '$lib/types';
	import { onMount } from 'svelte';

	type NavHref = '/atendimento' | '/dashboard' | '/administracao' | '/conta';
	type NavLink = { href: NavHref; label: string };

	let { children } = $props();

	let session = $state<SessionState>({ user: null, loading: true, error: '' });
	let loginForm = $state({ email: '', password: '', loading: false });
	let resetRequestForm = $state({ email: '' });
	let accountMessage = $state('');
	let pathname = $derived(page.url.pathname);
	let navLinks = $derived.by(() => {
		const links: NavLink[] = [
			{ href: '/atendimento', label: 'Atendimento' },
			{ href: '/dashboard', label: 'Dashboard' }
		];

		if (canAccessAdmin(session.user)) {
			links.push({ href: '/administracao', label: 'Administração' });
		}

		links.push({ href: '/conta', label: 'Conta' });
		return links;
	});

	setSessionContext({ session, loadSession, logout });

	onMount(() => {
		void loadSession();
	});

	function navClass(href: NavHref) {
		return pathname === href
			? 'bg-sky-600 text-white shadow-sm'
			: 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100';
	}

	async function loadSession() {
		session.loading = true;
		session.error = '';
		try {
			const data = await api<{ user: User }>('/api/auth/me');
			session.user = data.user;
		} catch (error) {
			session.user = null;
			session.error = error instanceof ApiError && error.status === 401 ? '' : errorMessage(error);
		} finally {
			session.loading = false;
		}
	}

	async function handleLogin(event: SubmitEvent) {
		event.preventDefault();
		loginForm.loading = true;
		session.error = '';
		try {
			await api<{ ok: boolean }>('/api/auth/login', {
				method: 'POST',
				body: JSON.stringify({ email: loginForm.email, password: loginForm.password })
			});
			loginForm.password = '';
			await loadSession();
		} catch (error) {
			session.error = errorMessage(error, 'Email ou senha inválidos.');
		} finally {
			loginForm.loading = false;
		}
	}

	async function requestPasswordReset(event: SubmitEvent) {
		event.preventDefault();
		accountMessage = '';
		try {
			await api<{ ok: boolean }>('/api/auth/request-password-reset', {
				method: 'POST',
				body: JSON.stringify({ email: resetRequestForm.email })
			});
			accountMessage = 'Se o email existir, enviaremos as instruções de redefinição.';
		} catch (error) {
			accountMessage = errorMessage(error);
		}
	}

	async function logout() {
		try {
			await api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
		} catch {
			/* Session cleanup in the UI still matters if the cookie is already invalid. */
		}
		session.user = null;
		await goto(resolve('/atendimento'));
	}
</script>

<svelte:head>
	<title>Tracker de conversão</title>
	<meta
		name="description"
		content="Painel para acompanhar atendimentos, conversões, vendas e performance das academias."
	/>
	<meta name="language" content="pt-BR" />
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="min-h-screen bg-slate-50 text-slate-950">
	{#if session.loading}
		<main class="mx-auto flex min-h-screen max-w-6xl items-center justify-center p-6">
			<p class="rounded-3xl bg-white px-6 py-5 text-slate-600 shadow-sm ring-1 ring-slate-200">
				Carregando sessão...
			</p>
		</main>
	{:else if !session.user}
		<main
			class="mx-auto grid min-h-screen max-w-6xl items-center gap-8 px-4 py-10 lg:grid-cols-[1.1fr_0.9fr]"
		>
			<section class="space-y-5">
				<p class="text-sm font-semibold tracking-[0.3em] text-sky-600 uppercase">
					Tracker de conversão
				</p>
				<h1 class="text-4xl font-bold tracking-tight text-slate-950 md:text-6xl">
					Conversão de atendimentos em tempo real.
				</h1>
				<p class="max-w-2xl text-lg text-slate-600">
					Acompanhe leads, vendas, perdas, aulas experimentais e performance por recepção, professor
					e academia.
				</p>
			</section>

			<section class="rounded-3xl bg-white p-6 shadow-xl ring-1 shadow-sky-950/10 ring-slate-200">
				<h2 class="text-2xl font-bold text-slate-900">Entrar</h2>
				<form class="mt-6 space-y-4" onsubmit={handleLogin}>
					<label class="block text-sm font-medium text-slate-700">
						Email
						<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="email"
							autocomplete="email"
							bind:value={loginForm.email}
							required
						/>
					</label>
					<label class="block text-sm font-medium text-slate-700">
						Senha
						<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="password"
							autocomplete="current-password"
							bind:value={loginForm.password}
							required
						/>
					</label>
					<button
						class="w-full rounded-2xl bg-sky-600 px-5 py-4 text-base font-bold text-white hover:bg-sky-700 disabled:opacity-60"
						disabled={loginForm.loading}
					>
						{loginForm.loading ? 'Entrando...' : 'Entrar no painel'}
					</button>
				</form>
				<Notice message={session.error} />
				<div class="mt-8 border-t border-slate-200 pt-6">
					<h3 class="font-semibold text-slate-900">Ajuda com acesso</h3>
					<div class="mt-4 grid gap-4">
						<form class="grid gap-3" onsubmit={requestPasswordReset}>
							<label class="text-sm font-medium text-slate-700">
								Solicitar redefinição
								<input
									class="mt-1 w-full rounded-2xl border-slate-300"
									type="email"
									placeholder="email@gmail.com"
									bind:value={resetRequestForm.email}
									required
								/>
							</label>
							<button
								class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
								>Enviar email</button
							>
						</form>
						<Notice message={accountMessage} />
					</div>
				</div>
			</section>
		</main>
	{:else}
		<header class="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
			<div
				class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between"
			>
				<div>
					<p class="text-xs font-semibold tracking-[0.3em] text-sky-600 uppercase">
						Tracker de conversão
					</p>
					<h1 class="text-xl font-bold text-slate-950">Tracker de conversão</h1>
				</div>
				<nav class="flex flex-wrap gap-2" aria-label="Navegação principal">
					{#each navLinks as link (link.href)}
						<a
							class={`rounded-2xl px-4 py-3 text-sm font-bold ${navClass(link.href)}`}
							href={resolve(link.href)}
							aria-current={pathname === link.href ? 'page' : undefined}
						>
							{link.label}
						</a>
					{/each}
				</nav>
				<div class="flex items-center gap-3 text-sm text-slate-600">
					<span>{session.user.name}</span>
					<button
						class="rounded-2xl border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50"
						onclick={logout}>Sair</button
					>
				</div>
			</div>
		</header>

		<main class="mx-auto max-w-7xl space-y-6 px-4 py-6">
			{@render children()}
		</main>
	{/if}
</div>
