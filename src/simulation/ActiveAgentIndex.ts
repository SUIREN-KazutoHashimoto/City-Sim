export class ActiveAgentIndex {
  private readonly words: Uint32Array;
  private activeCountValue = 0;

  constructor(readonly capacity: number) {
    this.words = new Uint32Array(Math.ceil(Math.max(0, capacity) / 32));
  }

  get size(): number { return this.activeCountValue; }

  has(id: number): boolean {
    if (id < 0 || id >= this.capacity) return false;
    const word = id >>> 5, mask = (1 << (id & 31)) >>> 0;
    return (this.words[word] & mask) !== 0;
  }

  set(id: number, active: boolean): void {
    if (id < 0 || id >= this.capacity) return;
    const word = id >>> 5, mask = (1 << (id & 31)) >>> 0, before = this.words[word];
    const present = (before & mask) !== 0;
    if (present === active) return;
    this.words[word] = active ? (before | mask) >>> 0 : (before & ~mask) >>> 0;
    this.activeCountValue += active ? 1 : -1;
  }

  add(id: number): void { this.set(id, true); }
  delete(id: number): void { this.set(id, false); }

  clear(): void { this.words.fill(0); this.activeCountValue = 0; }

  /** Iterate active IDs in exactly ascending agent-ID order. */
  forEachAscending(limitExclusive: number, visit: (id: number) => void): void {
    const limit = Math.max(0, Math.min(this.capacity, limitExclusive));
    const lastWord = Math.ceil(limit / 32);
    for (let wi = 0; wi < lastWord; wi++) {
      let bits = this.words[wi] >>> 0;
      while (bits !== 0) {
        const lsb = (bits & -bits) >>> 0;
        const bit = 31 - Math.clz32(lsb);
        const id = (wi << 5) + bit;
        if (id >= limit) return;
        visit(id);
        bits = (bits ^ lsb) >>> 0;
      }
    }
  }

  /** Return the smallest active ID >= start and < limitExclusive, or -1. */
  nextAtOrAfter(start: number, limitExclusive: number): number {
    const limit = Math.max(0, Math.min(this.capacity, limitExclusive));
    if (start < 0) start = 0;
    if (start >= limit) return -1;
    let wi = start >>> 5;
    const lastWord = Math.ceil(limit / 32);
    let bits = this.words[wi] >>> 0;
    const bitOffset = start & 31;
    if (bitOffset > 0) bits &= (0xffffffff << bitOffset) >>> 0;

    for (; wi < lastWord; wi++) {
      if (wi !== (start >>> 5)) bits = this.words[wi] >>> 0;
      if (wi === lastWord - 1 && (limit & 31) !== 0) bits &= (0xffffffff >>> (32 - (limit & 31))) >>> 0;
      if (bits === 0) continue;
      const lsb = (bits & -bits) >>> 0;
      return (wi << 5) + (31 - Math.clz32(lsb));
    }
    return -1;
  }
}
