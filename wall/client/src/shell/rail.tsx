import type { Screen } from '../screens/types';
import { Icon } from './icons';

// The left rail (spec section 9): one tap target per screen in config order. No swipes.
export function Rail({ screens, active, onSelect }: { screens: Screen[]; active: string | null; onSelect(id: string): void }) {
  return (
    <>
      {screens.map((s) => (
        <button
          type="button"
          class="rail-item"
          aria-current={s.id === active ? 'page' : undefined}
          onClick={() => onSelect(s.id)}
        >
          <Icon name={s.icon} />
          <span>{s.title}</span>
        </button>
      ))}
    </>
  );
}
