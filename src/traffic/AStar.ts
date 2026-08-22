export interface PathGraph { nodes: { x: number; z: number; edges: number[] }[]; edges: { to: number; length: number; speedLimit: number }[]; heuristic(a: number, b: number): number; }
export class AStar {
  private g: Float64Array; private f: Float64Array; private cameFrom: Int32Array; private closed: Uint8Array; private openFlag: Uint8Array; private heap: number[] = [];
  constructor(private net: PathGraph, private mode: 'drive' | 'walk' = 'drive') {
    const n = net.nodes.length; this.g = new Float64Array(n); this.f = new Float64Array(n); this.cameFrom = new Int32Array(n); this.closed = new Uint8Array(n); this.openFlag = new Uint8Array(n);
  }
  findPath(start: number, goal: number): number[] {
    const net = this.net;
    this.g.fill(Infinity); this.f.fill(Infinity); this.closed.fill(0); this.openFlag.fill(0); this.cameFrom.fill(-1); this.heap.length = 0;
    this.g[start] = 0; this.f[start] = net.heuristic(start, goal); this.push(start);
    while (this.heap.length) {
      const cur = this.pop();
      if (cur === goal) return this.reconstruct(goal);
      this.closed[cur] = 1;
      for (const edgeId of net.nodes[cur].edges) {
        const e = net.edges[edgeId], nb = e.to; if (this.closed[nb]) continue;
        const cost = this.mode === 'walk' ? e.length : e.length / e.speedLimit;
        const tentative = this.g[cur] + cost;
        if (tentative < this.g[nb]) { this.cameFrom[nb] = cur; this.g[nb] = tentative; const h = this.mode === 'walk' ? net.heuristic(nb, goal) : net.heuristic(nb, goal) / 27; this.f[nb] = tentative + h; if (!this.openFlag[nb]) this.push(nb); }
      }
    }
    return [];
  }
  private reconstruct(goal: number): number[] { const path: number[] = []; let n = goal; while (n !== -1) { path.push(n); n = this.cameFrom[n]; } path.reverse(); return path; }
  private push(node: number): void { this.openFlag[node] = 1; this.heap.push(node); let i = this.heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.f[this.heap[p]] <= this.f[this.heap[i]]) break; [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]]; i = p; } }
  private pop(): number { const top = this.heap[0], last = this.heap.pop()!; this.openFlag[top] = 0; if (this.heap.length) { this.heap[0] = last; let i = 0; const n = this.heap.length; for (;;) { const l = 2 * i + 1, r = 2 * i + 2; let s = i; if (l < n && this.f[this.heap[l]] < this.f[this.heap[s]]) s = l; if (r < n && this.f[this.heap[r]] < this.f[this.heap[s]]) s = r; if (s === i) break; [this.heap[s], this.heap[i]] = [this.heap[i], this.heap[s]]; i = s; } } return top; }
}
