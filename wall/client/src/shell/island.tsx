import type { NowPlaying } from './nowplaying';

// The "island" (milestone 7): a small floating pill at the bottom centre of every rail screen
// except the Spotify screen, while something is playing. A tap opens the Spotify screen.
export function Island({ now, onOpen }: { now: NowPlaying | null; onOpen(): void }) {
  if (!now) return null;
  return (
    <button type="button" class="island" data-paused={!now.playing || undefined} onClick={onOpen}>
      <span class="island__art">{now.thumb ? <img src={now.thumb} alt="" /> : null}</span>
      <span class="island__text">
        <span class="island__title">{now.title}</span>
        <span class="island__sub">{now.playing ? now.artist : 'Paused'} · {now.device.name}</span>
      </span>
      <span class="island__bars" aria-hidden="true"><i /><i /><i /></span>
    </button>
  );
}
