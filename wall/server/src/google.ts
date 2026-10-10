import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Google Calendar API, read-only, as a service account (spec section 1 rulings and section 5).
// The token exchange is a signed JWT (RFC 7523) made with node:crypto, so there is no Google SDK dependency.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TIMEOUT_MS = 10_000;
const FIELDS = 'items(id,status,summary,start,end,location,description,attendees(self,responseStatus)),nextPageToken';

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  location?: string;
  description?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export class GoogleError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`Google API ${status} ${reason}`);
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export class GoogleCalendar {
  private email: string;
  private key: string;
  private token: { value: string; expires: number } | null = null;
  private pending: Promise<string> | null = null; // one token request shared by parallel calls

  constructor(credentialsPath: string) {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { client_email?: string; private_key?: string };
    if (!creds.client_email || !creds.private_key) throw new Error('service account file has no client_email or private_key');
    this.email = creds.client_email;
    this.key = creds.private_key;
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expires - Date.now() > 60_000) return Promise.resolve(this.token.value);
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iss: this.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
    )}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.key).toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new GoogleError(res.status, body.error ?? 'token exchange failed');
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  // events.list with recurring events expanded, following every page.
  async listEvents(calendarId: string, timeMin: Date, timeMax: Date, timeZone: string): Promise<GoogleEvent[]> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        timeZone,
        fields: FIELDS,
      });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`, {
        headers: { authorization: `Bearer ${await this.accessToken()}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        error?: { errors?: { reason?: string }[]; status?: string };
      };
      if (!res.ok) {
        if (res.status === 401) this.token = null;
        throw new GoogleError(res.status, body.error?.errors?.[0]?.reason ?? body.error?.status ?? 'request failed');
      }
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }
}
