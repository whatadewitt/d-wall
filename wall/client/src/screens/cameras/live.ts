// One WebRTC live view (spec section 6). The offer goes to the server, which passes it to go2rtc.
// Only video is requested: audio stays off. close() releases the decoder.
import type { ScreenContext } from '../types';

export interface LiveStats { fps: number | null; avgFps: number | null; dropped: number | null; width: number | null; height: number | null }

const GATHER_MS = 1000;

// Wait for ICE gathering, but no longer than a second: some networks never report "complete",
// and on a LAN the host candidates are there almost at once. The timer only settles this promise,
// so it is harmless if it fires after the screen is gone.
function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, GATHER_MS);
  });
}

export function openLive(ctx: ScreenContext, cameraId: string, video: HTMLVideoElement, quality?: 'low') {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('video', { direction: 'recvonly' });
  let media: MediaStream | null = null;
  let closed = false;
  const startedAt = performance.now();

  pc.ontrack = (e) => {
    media = e.streams[0] ?? new MediaStream([e.track]);
    video.srcObject = media;
    void video.play().catch(() => {});
  };

  // Resolves with the stream quality the server chose ('main' or 'medium').
  const ready = (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc); // LAN only, host candidates: this is quick
    const res = await ctx.fetch(`/api/cameras/${encodeURIComponent(cameraId)}/webrtc${quality ? `?quality=${quality}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription!.sdp }),
    });
    if (!res.ok) throw new Error(`webrtc ${res.status}`);
    const answer = (await res.json()) as { sdp: string; stream: string };
    if (closed) return answer.stream;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    return answer.stream;
  })();

  async function stats(): Promise<LiveStats> {
    const report = await pc.getStats();
    let s: LiveStats = { fps: null, avgFps: null, dropped: null, width: null, height: null };
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
      const seconds = (performance.now() - startedAt) / 1000;
      s = {
        fps: r.framesPerSecond ?? null,
        avgFps: r.framesDecoded != null && seconds > 0 ? Math.round((r.framesDecoded / seconds) * 10) / 10 : null,
        dropped: r.framesDropped ?? null,
        width: r.frameWidth ?? null,
        height: r.frameHeight ?? null,
      };
    });
    return s;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    pc.ontrack = null;
    pc.close();
    media?.getTracks().forEach((t) => t.stop());
    media = null;
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load(); // releases the decoder (section 6)
  }

  return { ready, stats, close };
}

export type Live = ReturnType<typeof openLive>;
