import { createContext } from 'svelte';
import type { User } from '$lib/types';

export type SessionState = {
	user: User | null;
	loading: boolean;
	error: string;
};

export type SessionContext = {
	session: SessionState;
	loadSession: () => Promise<void>;
	logout: () => Promise<void>;
};

export const [getSessionContext, setSessionContext] = createContext<SessionContext>();
