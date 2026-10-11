// What the server sends (server/src/providers/spotify.ts).
export type Problem = 'not-configured' | 'auth' | 'premium' | 'rate' | 'unavailable';
export interface PlayerView {
  ok: boolean;
  problem?: Problem;
  playing: boolean;
  item: { title: string; artist: string; album: string; art: string | null; durationMs: number } | null;
  progressMs: number;
  device: { id: string; name: string; type: string; volume: number | null } | null;
  target: string | null;
  at: number;
}
export interface DeviceView { id: string; name: string; type: string; active: boolean }
export interface Sheet { devices: DeviceView[] | null; targetFound: boolean; error: string | null }

const svg = (d: preact.JSX.Element, cls?: string) => (
  <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>
);
const Prev = () => svg(<path d="M7 6v12M18 6l-8 6 8 6z" fill="currentColor" />);
const Next = () => svg(<path d="M17 6v12M6 6l8 6-8 6z" fill="currentColor" />);
const Play = () => svg(<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />);
const Pause = () => svg(<path d="M8.5 6v12M15.5 6v12" stroke-width="3" />);
const Speaker = () => svg(<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />, 'spot-vol__icon');
const Note = () => svg(<path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z" />, 'spot-art__note');
const Check = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 'spot-device__check');
const Close = () => svg(<path d="M6 6l12 12M18 6L6 18" />);

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const PROBLEMS: Record<Problem, string> = {
  'not-configured': "Spotify isn't set up yet. The milestone 7 report has the steps.",
  auth: 'The Spotify sign-in has expired. Run the sign-in step again.',
  premium: 'Controlling playback needs Spotify Premium.',
  rate: 'Spotify asked us to slow down. Back in a moment.',
  unavailable: "Spotify isn't responding.",
};

export function SpotifyView(p: {
  view: PlayerView | null;
  progressMs: number;
  playing: boolean;
  volume: number | null;
  message: string | null;
  sheet: Sheet | null;
  time: string;
  date: string;
  toggle(): void;
  skip(dir: 'next' | 'previous'): void;
  volumeInput(v: number): void;
  volumeCommit(v: number): void;
  playOnTarget(): void;
  openSheet(): void;
  closeSheet(): void;
  transfer(id: string): void;
}) {
  const v = p.view;
  const item = v?.item ?? null;
  const target = v?.target ?? null;
  const onTarget = !!v?.device && v.device.name === target;
  const problem = v && !v.ok && v.problem ? PROBLEMS[v.problem] : null;
  const note = p.message ?? problem;
  return (
    <div class="spot">
      <header class="spot-head">
        <div class="spot-head__title">
          <h1 class="spot-title">Spotify</h1>
          <span class="spot-subtitle">{v?.device ? `Playing on ${v.device.name}` : 'Not playing'}</span>
        </div>
        <div class="spot-clock">
          <div class="spot-clock__time">{p.time}</div>
          <div class="spot-clock__date">{p.date}</div>
        </div>
      </header>

      <div class="spot-body">
        <div class="spot-art">
          {item?.art ? <img class="spot-art__img" src={item.art} alt="" /> : <Note />}
        </div>

        <div class="spot-side">
          <div class="spot-track">
            <div class="spot-track__title">{item ? item.title : 'Nothing playing'}</div>
            <div class="spot-track__artist">
              {item ? item.artist : target ? `Start something in the Spotify app, or play on ${target}.` : 'Start something in the Spotify app.'}
            </div>
            {item?.album ? <div class="spot-track__album">{item.album}</div> : null}
          </div>

          {item ? (
            <div class="spot-progress">
              <div class="spot-progress__bar">
                <div class="spot-progress__fill" style={{ width: `${Math.min(100, (p.progressMs / Math.max(1, item.durationMs)) * 100)}%` }} />
              </div>
              <div class="spot-progress__times">
                <span>{mmss(p.progressMs)}</span>
                <span>{mmss(item.durationMs)}</span>
              </div>
            </div>
          ) : null}

          <div class="spot-controls">
            <button class="spot-btn" aria-label="Previous" disabled={!v?.device} onClick={() => p.skip('previous')}><Prev /></button>
            <button class="spot-btn spot-btn--play" aria-label={p.playing ? 'Pause' : 'Play'} disabled={!v?.device} onClick={p.toggle}>
              {p.playing ? <Pause /> : <Play />}
            </button>
            <button class="spot-btn" aria-label="Next" disabled={!v?.device} onClick={() => p.skip('next')}><Next /></button>
          </div>

          {p.volume !== null ? (
            <label class="spot-vol">
              <Speaker />
              <input
                class="spot-vol__range"
                type="range"
                min={0}
                max={100}
                step={1}
                value={p.volume}
                onInput={(e) => p.volumeInput(Number(e.currentTarget.value))}
                onChange={(e) => p.volumeCommit(Number(e.currentTarget.value))}
              />
              <span class="spot-vol__value">{p.volume}</span>
            </label>
          ) : null}

          <div class="spot-devices">
            <button class="spot-pill" onClick={p.openSheet}>Speakers</button>
            {target && !onTarget ? (
              <button class="spot-pill spot-pill--accent" onClick={p.playOnTarget}>Play on {target}</button>
            ) : null}
          </div>

          {note ? <div class="spot-note">{note}</div> : null}
        </div>
      </div>

      {p.sheet ? (
        <div class="spot-scrim" onClick={(e) => e.target === e.currentTarget && p.closeSheet()}>
          <div class="spot-sheet">
            <div class="spot-sheet__head">
              <h2 class="spot-sheet__title">Play on</h2>
              <button class="spot-btn spot-btn--close" aria-label="Close" onClick={p.closeSheet}><Close /></button>
            </div>
            {p.sheet.error ? <div class="spot-note">{p.sheet.error}</div> : null}
            {p.sheet.devices === null && !p.sheet.error ? <div class="spot-sheet__empty">Looking for speakers…</div> : null}
            {p.sheet.devices?.length === 0 ? <div class="spot-sheet__empty">Spotify can't see any speakers right now.</div> : null}
            <div class="spot-sheet__list">
              {p.sheet.devices?.map((d) => (
                <button class="spot-device" data-active={d.active || undefined} onClick={() => p.transfer(d.id)}>
                  <span class="spot-device__name">{d.name}</span>
                  <span class="spot-device__type">{d.type}</span>
                  {d.active ? <Check /> : null}
                </button>
              ))}
            </div>
            {p.sheet.devices && target && !p.sheet.targetFound ? (
              <div class="spot-sheet__hint">
                {target} isn't showing up. Cast to it once from the Spotify app on your phone, and Spotify lists it here for a while after.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
