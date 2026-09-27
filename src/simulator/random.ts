/**
 * Seedable pseudo-random generator (mulberry32). The same seed always yields the
 * same sequence, which is what makes demo runs and tests repeatable.
 */
export class Random {
  private state: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Cannot pick from an empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /** Normally distributed value (Box-Muller). */
  normal(mean: number, stddev: number): number {
    if (this.spareNormal !== null) {
      const z = this.spareNormal;
      this.spareNormal = null;
      return mean + stddev * z;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spareNormal = mag * Math.sin(2 * Math.PI * v);
    return mean + stddev * mag * Math.cos(2 * Math.PI * v);
  }
}

/** Derives an independent stream seed so optional features do not disturb the main sequence. */
export function deriveSeed(seed: number, stream: number): number {
  let h = (seed ^ Math.imul(stream + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
