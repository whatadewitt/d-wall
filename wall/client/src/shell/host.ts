import type { Mount, Screen } from '../screens/types';
import { createScreenContext, type ContextDeps } from './context';
import { subscriptionCount } from './events';
import { timerCount } from './timers';

let leaks = 0;
export const leakCount = () => leaks;

// Mounts one screen at a time into a layer. The main stage and the overlay layer each have one.
export class ScreenHost {
  private current: { id: string; root: HTMLElement; owner: string; dispose(): void } | null = null;
  private token = 0;

  constructor(
    private name: string,
    private layer: HTMLElement,
    private deps: ContextDeps,
  ) {}

  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  async show(screen: Screen): Promise<void> {
    this.unmount();
    const token = ++this.token;
    let mod: { mount: Mount };
    try {
      mod = await screen.load();
    } catch (err) {
      console.error(`could not load screen ${screen.id}`, err);
      return;
    }
    if (token !== this.token) return; // another show() or unmount() happened while loading

    const root = document.createElement('div');
    root.className = 'screen-root';
    root.dataset.screen = screen.id;
    this.layer.append(root);
    const owner = `${this.name}:${screen.id}#${token}`;
    const { ctx, dispose } = createScreenContext(owner, this.deps);
    this.current = { id: screen.id, root, owner, dispose };
    this.layer.dataset.mounted = screen.id;
    try {
      await mod.mount(root, ctx);
    } catch (err) {
      console.error(`screen ${screen.id} failed to mount`, err);
    }
  }

  unmount(): void {
    this.token++;
    const c = this.current;
    if (!c) return;
    this.current = null;
    c.dispose();

    // Spec section 4: after unmount the root must be empty and the subscription count back to baseline.
    const left: string[] = [];
    if (c.root.childNodes.length) left.push(`${c.root.childNodes.length} DOM nodes`);
    if (subscriptionCount(c.owner)) left.push(`${subscriptionCount(c.owner)} subscriptions`);
    if (timerCount(c.owner)) left.push(`${timerCount(c.owner)} timers`);
    if (left.length) {
      leaks++;
      if (import.meta.env.DEV) console.warn(`leak: screen ${c.id} left ${left.join(', ')} after unmount`);
    }
    c.root.remove();
    delete this.layer.dataset.mounted;
  }
}
