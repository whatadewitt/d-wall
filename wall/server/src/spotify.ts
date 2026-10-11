// A small Spotify Web API client for the spotify provider. The server holds a refresh token from
// the one-time sign-in (spotify-auth.ts) and trades it for short-lived access tokens. Tokens never
// reach a log or the client.

const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_URL ?? 'https://accounts.spotify.com';
const API = process.env.SPOTIFY_API_URL ?? 'https://api.spotify.com/v1';
const TIMEOUT_MS = 8000;
const EARLY_REFRESH_MS = 60_000; // refresh a minute before the access token expires

export class SpotifyError extends Error {
  constructor(
    readonly status: number,   // Spotify's HTTP status, or 0 for a network failure
    readonly reason: string,   // Spotify's reason code (NO_ACTIVE_DEVICE, PREMIUM_REQUIRED …), or ours
    message: string,
    readonly retryAfterSec = 0,
  ) {
    super(message);
  }
}

export class Spotify {
  private access = '';
  private expiresAt = 0;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private refreshToken: string,
    private readonly onNewRefreshToken: () => void = () => {},
  ) {}

  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.access && Date.now() < this.expiresAt - EARLY_REFRESH_MS) return this.access;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${ACCOUNTS}/api/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SpotifyError(0, 'network', `token refresh failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
    if (!res.ok || !body.access_token) {
      // invalid_grant: the refresh token was revoked or has expired, so the sign-in must be redone.
      throw new SpotifyError(401, body.error === 'invalid_grant' ? 'auth' : 'token', `token refresh refused: ${body.error ?? res.status}`);
    }
    if (body.refresh_token && body.refresh_token !== this.refreshToken) {
      this.refreshToken = body.refresh_token;
      this.onNewRefreshToken();
    }
    this.access = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.access;
  }

  // One Web API call. A 401 refreshes the access token and tries once more. Returns the parsed JSON
  // body, or null for an empty one (204, or the player endpoints' empty 200s).
  async call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? (method === 'GET' ? undefined : '') : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new SpotifyError(0, 'network', `${method} ${path.split('?')[0]}: ${(err as Error).message}`);
      }
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // some player endpoints answer 200 with a non-JSON body
      }
      if (res.ok) return json;
      const e = (json as { error?: { message?: string; reason?: string } } | null)?.error;
      throw new SpotifyError(res.status, e?.reason ?? '', `${method} ${path.split('?')[0]}: ${res.status} ${e?.message ?? ''}`.trim(),
        Number(res.headers.get('retry-after')) || 0);
    }
  }
}

// Spotify's image host. Album art URLs look like https://i.scdn.co/image/<hex id>.
export const IMAGE_BASE = process.env.SPOTIFY_IMAGE_URL ?? 'https://i.scdn.co/image/';
export const imageId = (url: string | undefined): string | null => url?.match(/^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{16,64})$/)?.[1] ?? null;
