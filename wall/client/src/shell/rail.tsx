import { Icon } from './icons';

export interface RailItem { id: string; title: string; icon: string }

// The left rail (spec section 9): one tap target per screen in config order. No swipes.
// An item can also be a link that opens another app (shell/links.ts).
export function Rail({ screens, active, onSelect }: { screens: RailItem[]; active: string | null; onSelect(id: string): void }) {
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
