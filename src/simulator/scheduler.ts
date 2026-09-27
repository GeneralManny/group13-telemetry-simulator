/**
 * Fixed-rate ticker. Uses a self-correcting setTimeout chain so the average rate holds
 * even when individual ticks run late. If the process stalls, it resynchronises instead
 * of firing a burst of catch-up ticks.
 */
export class Ticker {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private nextAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => void,
  ) {}

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.nextAt = performance.now();
    this.schedule(0);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      this.nextAt += this.intervalMs;
      this.onTick();
      if (!this.active) return;
      const now = performance.now();
      if (this.nextAt < now - this.intervalMs * 5) this.nextAt = now;
      this.schedule(Math.max(0, this.nextAt - now));
    }, delayMs);
  }
}
