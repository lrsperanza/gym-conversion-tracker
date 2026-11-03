/**
 * Access token for Google APIs without an SDK or key file.
 *
 * On Cloud Run the metadata server hands out tokens for the service's own service account. Locally
 * there is no metadata server, so it falls back to `GCS_ACCESS_TOKEN` or the account logged in to the
 * gcloud CLI. Tokens are cached until a minute before they expire.
 */

const METADATA_TOKEN_URL =
	'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const REFRESH_MARGIN_MS = 60_000;
/** gcloud does not report the expiry; its tokens last an hour. */
const GCLOUD_TOKEN_TTL_MS = 50 * 60_000;

let cached: { token: string; expiresAt: number } | null = null;
let pending: Promise<string> | null = null;
let metadataUnavailable = false;

export async function gcpAccessToken(): Promise<string> {
	if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
	pending ??= fetchToken().finally(() => {
		pending = null;
	});
	return pending;
}

async function fetchToken(): Promise<string> {
	if (Bun.env.GCS_ACCESS_TOKEN) return Bun.env.GCS_ACCESS_TOKEN;

	if (!metadataUnavailable) {
		try {
			const response = await fetch(METADATA_TOKEN_URL, {
				headers: { 'Metadata-Flavor': 'Google' },
				signal: AbortSignal.timeout(2_000)
			});
			if (response.ok) {
				const body = (await response.json()) as { access_token: string; expires_in: number };
				cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1_000 };
				return body.access_token;
			}
		} catch {
			// Not on GCP; remember so every call does not wait for the timeout.
		}
		metadataUnavailable = true;
	}

	const gcloud = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
	const result = Bun.spawnSync([gcloud, 'auth', 'print-access-token'], { stderr: 'pipe' });
	const token = result.stdout.toString().trim();
	if (result.exitCode !== 0 || !token) {
		throw new Error(`Sem credencial do Google Cloud: ${result.stderr.toString().trim() || 'gcloud não retornou token'}`);
	}
	cached = { token, expiresAt: Date.now() + GCLOUD_TOKEN_TTL_MS };
	return token;
}
