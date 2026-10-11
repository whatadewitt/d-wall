// The go2rtc sidecar's HTTP API, reachable only on the Docker network (spec section 10).
// Streams are added at runtime, so camera addresses (which carry Protect's RTSPS tokens)
// never touch a file. go2rtc runs with an inline config and answers 400 "Config file disabled"
// to PUT /api/streams even though the stream is created, so syncStreams checks the stream list.

const TIMEOUT_MS = 5000;

// go2rtc's error text, for the log. Addresses are cut out: they can carry Protect's stream tokens.
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>').trim().slice(0, 200);
}

export class Go2rtc {
  constructor(private base: string) {}

  private async call(path: string, init: RequestInit = {}, timeout = TIMEOUT_MS): Promise<Response> {
    return fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  }

  // Make go2rtc's streams match `wanted` (name -> source URL). Returns the names that are in place.
  async syncStreams(wanted: Map<string, string>): Promise<string[]> {
    const current = async () => (await (await this.call('/api/streams')).json()) as Record<string, { producers?: { url?: string }[] } | null>;
    let streams = await current();
    for (const [name, src] of wanted) {
      if (streams[name]?.producers?.some((p) => p.url === src)) continue;
      if (streams[name]) await this.call(`/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' });
      await this.call(`/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: 'PUT' });
    }
    streams = await current();
    return [...wanted].filter(([name, src]) => streams[name]?.producers?.some((p) => p.url === src)).map(([name]) => name);
  }

  async frame(stream: string, width: number): Promise<Buffer> {
    const res = await this.call(`/api/frame.jpeg?src=${encodeURIComponent(stream)}&width=${width}`, {}, 8000);
    if (!res.ok) throw new Error(`go2rtc frame ${res.status}: ${await reason(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // WebRTC offer/answer exchange for one stream.
  async webrtc(stream: string, sdp: string): Promise<string> {
    const res = await this.call(`/api/webrtc?src=${encodeURIComponent(stream)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp }),
    });
    if (!res.ok) throw new Error(`go2rtc webrtc ${res.status}: ${await reason(res)}`);
    const answer = (await res.json()) as { type?: string; sdp?: string };
    if (answer.type !== 'answer' || !answer.sdp) throw new Error('go2rtc webrtc: no answer');
    return answer.sdp;
  }
}
