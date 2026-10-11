import dingUrl from '../sounds/ding.wav';

// The doorbell ding (milestone 3). Played through Fully Kiosk's JavaScript interface, because a
// page's own audio is unreliable while the screen is off; a plain Audio element is the fallback
// outside Fully (a laptop browser). Volume goes to the maximum for the ding and back afterwards.
const STREAM_MEDIA = 3;
const RESTORE_AFTER_MS = 4000;

export type SoundResult = 'fully' | 'html' | 'failed';

export function playDing(): SoundResult {
  const url = new URL(dingUrl, location.href).href;
  const fully = window.fully;
  if (fully?.playSound) {
    try {
      let before: number | null = null;
      try {
        const v = fully.getAudioVolume?.(STREAM_MEDIA);
        before = typeof v === 'number' && v >= 0 ? v : null;
      } catch {
        // older Fully versions: leave the volume as it is afterwards
      }
      fully.setAudioVolume?.(100, STREAM_MEDIA);
      try {
        fully.playSound(url, false, STREAM_MEDIA);
      } catch {
        fully.playSound(url, false); // versions without the stream argument
      }
      if (before !== null && before < 100) {
        const restore = before;
        window.setTimeout(() => {
          try {
            fully.setAudioVolume?.(restore, STREAM_MEDIA);
          } catch {
            // nothing to do
          }
        }, RESTORE_AFTER_MS);
      }
      return 'fully';
    } catch {
      return 'failed';
    }
  }
  try {
    void new Audio(url).play().catch(() => {});
    return 'html';
  } catch {
    return 'failed';
  }
}
