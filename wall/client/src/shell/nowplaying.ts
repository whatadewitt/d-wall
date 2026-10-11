// What's playing on Spotify (server/src/providers/spotify.ts). The server publishes `spotify.now`
// when it changes; GET /api/spotify/now has the current value. Shared by the island, the Spotify
// screen and the lock screen.
export interface NowPlaying {
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  art: string | null;
  thumb: string | null;
  durationMs: number;
  progressMs: number;
  at: number; // server time progressMs was read
  device: { name: string; type: string };
}
export type SpotifyProblem = 'not-configured' | 'auth' | 'rate' | 'unavailable';
export interface SpotifyMessage { now: NowPlaying | null; problem: SpotifyProblem | null }

// Progress now, moved on locally from when the message arrived.
export function progressOf(now: NowPlaying, receivedAt: number): number {
  return Math.min(now.durationMs, now.progressMs + (now.playing ? Date.now() - receivedAt : 0));
}
