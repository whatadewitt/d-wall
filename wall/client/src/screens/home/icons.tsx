// Tile icons, drawn like the rail's: 24-unit grid, 1.8 stroke, round caps.
import type { JSX } from 'preact';

const paths: Record<string, JSX.Element> = {
  light: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></>,
  switch: <><rect x="7" y="3.5" width="10" height="17" rx="3" /><circle cx="12" cy="9" r="1.6" /></>,
  fan: <><circle cx="12" cy="12" r="1.8" /><path d="M12 10.2C11 6 12.5 3.5 15 4c2 .5 1.5 3.5-1.2 6.4M13.6 12.9c4.2 1.1 6 3.4 4.9 5.6-.9 1.8-3.8.8-5.7-2.6M10.4 13c-3 3.2-5.9 3.6-7 1.5-.9-1.8 1.4-3.8 5.3-4" /></>,
  scene: <><path d="M12 3.5l1.6 4.9 4.9 1.6-4.9 1.6L12 16.5l-1.6-4.9L5.5 10l4.9-1.6z" /><path d="M18 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>,
  climate: <><path d="M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0z" /><path d="M12 9v6" /></>,
  cover: <><path d="M4 4.5h16M5.5 4.5v15h13v-15M5.5 9h13M5.5 13.5h13" /></>,
  garage: <><path d="M3.5 10L12 4l8.5 6v10h-17z" /><path d="M7 20v-7h10v7M7 15.5h10" /></>,
  media_player: <><rect x="3.5" y="5" width="17" height="12" rx="2.5" /><path d="M10.5 8.5v5l4-2.5z" /><path d="M8.5 20h7" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /><path d="M12 14.5v2" /></>,
  alarm: <><path d="M12 3.5l7.5 3v5c0 4.5-3.2 8-7.5 9-4.3-1-7.5-4.5-7.5-9v-5z" /><path d="M9 12l2 2 4-4" /></>,
  sensor: <><path d="M4.5 16a7.5 7.5 0 1 1 15 0" /><path d="M12 16l3.5-4.5" /><circle cx="12" cy="16" r="1.2" /></>,
};

export function TileIcon({ type }: { type: string }) {
  return (
    <svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[type] ?? paths.switch}
    </svg>
  );
}
