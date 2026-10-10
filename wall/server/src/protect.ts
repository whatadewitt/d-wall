import { request } from 'node:https';

// UniFi Protect, read-only, as the local view-only user (spec section 2). Used to look up each
// camera's medium and low stream addresses and its snapshot endpoint (milestone 2).
// This is the API Protect's own web app uses; it is not a published, versioned API.
// The UDM Pro serves a self-signed certificate, so certificate checks are off for this host only.

const TIMEOUT_MS = 5000;
const RELOGIN_BACKOFF_MS = 60_000; // the UDM locks accounts after repeated failed logins

export interface ProtectChannel { id: number; name?: string; rtspAlias?: string; isRtspEnabled?: boolean }
export interface ProtectCamera { id: string; name: string; channels: ProtectChannel[] }

export class ProtectError extends Error {
  constructor(readonly status: number, what: string) {
    super(`Protect ${what}: ${status}`);
  }
}

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function send(host: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port: 443, method, path, headers, rejectUnauthorized: false, timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export class ProtectClient {
  private cookie: string | null = null;
  private lastLoginFailure = 0;

  constructor(
    readonly host: string,
    private username: string,
    private password: string,
  ) {}

  private async login(): Promise<void> {
    if (Date.now() - this.lastLoginFailure < RELOGIN_BACKOFF_MS) throw new ProtectError(0, 'login backing off');
    const body = JSON.stringify({ username: this.username, password: this.password, rememberMe: true });
    const res = await send(this.host, 'POST', '/api/auth/login', { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body);
    const token = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('TOKEN='));
    if (res.status !== 200 || !token) {
      this.lastLoginFailure = Date.now();
      throw new ProtectError(res.status, 'login');
    }
    this.cookie = token.split(';')[0];
  }

  private async get(path: string, what: string): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie) await this.login();
      const res = await send(this.host, 'GET', path, { cookie: this.cookie!, accept: '*/*' });
      if (res.status === 401 || res.status === 403) {
        this.cookie = null; // token expired: log in again once
        continue;
      }
      if (res.status !== 200) throw new ProtectError(res.status, what);
      return res.body;
    }
    throw new ProtectError(401, what);
  }

  async cameras(): Promise<ProtectCamera[]> {
    return JSON.parse((await this.get('/proxy/protect/api/cameras', 'cameras')).toString('utf8')) as ProtectCamera[];
  }

  async snapshot(cameraId: string, width: number): Promise<Buffer> {
    return this.get(`/proxy/protect/api/cameras/${encodeURIComponent(cameraId)}/snapshot?ts=${Date.now()}&force=true&w=${width}`, 'snapshot');
  }
}
