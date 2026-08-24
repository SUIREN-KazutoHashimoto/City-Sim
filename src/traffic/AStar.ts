export interface PathGraph { nodes: { x: number; z: number; edges: number[] }[]; edges: { to: number; length: number; speedLimit: number }[]; heuristic(a: number, b: number): number; }

/**
 * Static road/sidewalk graph A*.
 *
 * Hot-path optimizations:
 * - reset only nodes touched by the previous search instead of filling every work array,
 * - keep a bounded LRU of completed routes because commute/bus requests frequently repeat
 *   the same node pairs on a static graph.
 */
export class AStar {
  private g: Float64Array;
  private f: Float64Array;
  private cameFrom: Int32Array;
  private closed: Uint8Array;
  private openFlag: Uint8Array;
  private touchedFlag: Uint8Array;
  private touched: number[] = [];
  private heap: number[] = [];
  private readonly routeCache = new Map<string, number[]>();
  private readonly routeCacheLimit: number;

  constructor(private net: PathGraph, private mode: 'drive' | 'walk' = 'drive', routeCacheLimit = 4096) {
    const n = net.nodes.length;
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.openFlag = new Uint8Array(n);
    this.touchedFlag = new Uint8Array(n);
    this.routeCacheLimit = Math.max(0, routeCacheLimit | 0);
  }

  findPath(start: number, goal: number): number[] {
    if (start < 0 || goal < 0 || start >= this.net.nodes.length || goal >= this.net.nodes.length) return [];
    if (start === goal) return [start];

    const cacheKey = `${start}:${goal}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached !== undefined) {
      // Refresh insertion order to make Map act as a small LRU.
      this.routeCache.delete(cacheKey);
      this.routeCache.set(cacheKey, cached);
      return cached;
    }

    this.resetTouched();
    this.heap.length = 0;
    this.touch(start);
    this.g[start] = 0;
    this.f[start] = this.net.heuristic(start, goal);
    this.push(start);

    const net = this.net;
    while (this.heap.length) {
      const cur = this.pop();
      if (cur === goal) {
        const path = this.reconstruct(goal);
        this.remember(cacheKey, path);
        return path;
      }
      this.closed[cur] = 1;
      for (const edgeId of net.nodes[cur].edges) {
        const e = net.edges[edgeId], nb = e.to;
        this.touch(nb);
        if (this.closed[nb]) continue;
        const cost = this.mode === 'walk' ? e.length : e.length / e.speedLimit;
        const tentative = this.g[cur] + cost;
        if (tentative < this.g[nb]) {
          this.cameFrom[nb] = cur;
          this.g[nb] = tentative;
          const h = this.mode === 'walk' ? net.heuristic(nb, goal) : net.heuristic(nb, goal) / 27;
          this.f[nb] = tentative + h;
          if (!this.openFlag[nb]) this.push(nb);
          else this.fixHeapNode(nb);
        }
      }
    }

    this.remember(cacheKey, []);
    return [];
  }

  clearCache(): void { this.routeCache.clear(); }

  private touch(node: number): void {
    if (this.touchedFlag[node]) return;
    this.touchedFlag[node] = 1;
    this.touched.push(node);
    this.g[node] = Infinity;
    this.f[node] = Infinity;
    this.cameFrom[node] = -1;
    this.closed[node] = 0;
    this.openFlag[node] = 0;
  }

  private resetTouched(): void {
    for (let i = 0; i < this.touched.length; i++) this.touchedFlag[this.touched[i]] = 0;
    this.touched.length = 0;
  }

  private remember(key: string, path: number[]): void {
    if (this.routeCacheLimit <= 0) return;
    this.routeCache.set(key, path);
    if (this.routeCache.size <= this.routeCacheLimit) return;
    const oldest = this.routeCache.keys().next().value as string | undefined;
    if (oldest !== undefined) this.routeCache.delete(oldest);
  }

  private reconstruct(goal: number): number[] {
    const path: number[] = [];
    let n = goal;
    while (n !== -1) { path.push(n); n = this.cameFrom[n]; }
    path.reverse();
    return path;
  }

  private push(node: number): void {
    this.openFlag[node] = 1;
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  /** Re-establish heap order after an already-open node receives a lower f score. */
  private fixHeapNode(node: number): void {
    for (let i = 0; i < this.heap.length; i++) {
      if (this.heap[i] !== node) continue;
      this.bubbleUp(i);
      return;
    }
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[this.heap[p]] <= this.f[this.heap[i]]) break;
      [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]];
      i = p;
    }
  }

  private pop(): number {
    const top = this.heap[0], last = this.heap.pop()!;
    this.openFlag[top] = 0;
    if (this.heap.length) {
      this.heap[0] = last;
      let i = 0;
      const n = this.heap.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < n && this.f[this.heap[l]] < this.f[this.heap[s]]) s = l;
        if (r < n && this.f[this.heap[r]] < this.f[this.heap[s]]) s = r;
        if (s === i) break;
        [this.heap[s], this.heap[i]] = [this.heap[i], this.heap[s]];
        i = s;
      }
    }
    return top;
  }
}
