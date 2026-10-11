import type { NowPlaying, SpotifyProblem } from '../../shell/nowplaying';

const svg = (d: preact.JSX.Element, cls: string) => (
  <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>
);
const Note = () => svg(<path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z" />, 'spot-art__note');
const SpeakerIcon = () => svg(<><rect x="6" y="3" width="12" height="18" rx="3" /><circle cx="12" cy="14" r="3" /><path d="M12 7.5h.01" /></>, 'spot-speaker__icon');

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Spotify's device types, in words.
const TYPES: Record<string, string> = {
  CastAudio: 'Google Cast speaker', CastVideo: 'Google Cast display', Speaker: 'Speaker', Tablet: 'Tablet',
  Smartphone: 'Phone', Computer: 'Computer', TV: 'TV', AVR: 'Receiver', GameConsole: 'Game console', Automobile: 'Car',
};

const PROBLEMS: Record<SpotifyProblem, string> = {
  'not-configured': "Spotify isn't set up yet. The milestone 7 report has the steps.",
  auth: 'The Spotify sign-in has expired. Run the sign-in step again.',
  rate: 'Spotify asked us to slow down. Back in a moment.',
  unavailable: "Spotify isn't responding.",
};

export function SpotifyView(p: { now: NowPlaying | null; problem: SpotifyProblem | null; progressMs: number; time: string; date: string }) {
  const { now } = p;
  return (
    <div class="spot">
      <header class="spot-head">
        <div class="spot-head__title">
          <h1 class="spot-title">Spotify</h1>
          <span class="spot-subtitle">{now ? (now.playing ? 'Now playing' : 'Paused') : 'Nothing playing'}</span>
        </div>
        <div class="spot-clock">
          <div class="spot-clock__time">{p.time}</div>
          <div class="spot-clock__date">{p.date}</div>
        </div>
      </header>

      <div class="spot-body">
        <div class="spot-art" data-paused={(now && !now.playing) || undefined}>
          {now?.art ? <img class="spot-art__img" src={now.art} alt="" /> : <Note />}
        </div>

        <div class="spot-side">
          <div class="spot-track">
            <div class="spot-track__title">{now ? now.title : 'Nothing playing'}</div>
            <div class="spot-track__artist">{now ? now.artist : 'Start Spotify on the kitchen Hub or a tablet, and it shows up here.'}</div>
            {now?.album ? <div class="spot-track__album">{now.album}</div> : null}
          </div>

          {now ? (
            <div class="spot-progress">
              <div class="spot-progress__bar">
                <div class="spot-progress__fill" style={{ width: `${Math.min(100, (p.progressMs / Math.max(1, now.durationMs)) * 100)}%` }} />
              </div>
              <div class="spot-progress__times">
                <span>{mmss(p.progressMs)}</span>
                <span>{mmss(now.durationMs)}</span>
              </div>
            </div>
          ) : null}

          {now ? (
            <div class="spot-speaker">
              <SpeakerIcon />
              <div>
                <div class="spot-speaker__name">{now.device.name}</div>
                <div class="spot-speaker__type">{TYPES[now.device.type] ?? now.device.type}</div>
              </div>
            </div>
          ) : null}

          {p.problem ? <div class="spot-note">{PROBLEMS[p.problem]}</div> : null}
        </div>
      </div>
    </div>
  );
}
