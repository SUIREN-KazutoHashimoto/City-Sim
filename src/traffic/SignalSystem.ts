import { RoadNetwork } from './RoadNetwork';
import { makeRng } from '../core/math';

/**
 * 車道信号と歩行者信号を *分離* して管理。将来のスクランブルにも対応。
 * Concurrent(並行式): 軸Aの車が青→軸Aに平行な歩行者も青。
 * Scramble(完全歩車分離): 全車赤の専用フェーズで全方向の歩行者が青。
 */
export enum SignalMode { Concurrent = 0, Scramble = 1 }

interface PhaseStep {
  vehGreenAxis: -1 | 0 | 1;
  vehYellow: boolean;
  pedWalkAxis: -1 | 0 | 1 | 2; // 2=全方向
  duration: number;
}
const GREEN = 14, YELLOW = 3, SCRAMBLE = 8;
function concurrentProgram(): PhaseStep[] {
  return [
    { vehGreenAxis: 0, vehYellow: false, pedWalkAxis: 0, duration: GREEN },
    { vehGreenAxis: 0, vehYellow: true, pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: 1, vehYellow: false, pedWalkAxis: 1, duration: GREEN },
    { vehGreenAxis: 1, vehYellow: true, pedWalkAxis: -1, duration: YELLOW },
  ];
}
function scrambleProgram(): PhaseStep[] {
  return [
    { vehGreenAxis: 0, vehYellow: false, pedWalkAxis: -1, duration: GREEN },
    { vehGreenAxis: 0, vehYellow: true, pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: 1, vehYellow: false, pedWalkAxis: -1, duration: GREEN },
    { vehGreenAxis: 1, vehYellow: true, pedWalkAxis: -1, duration: YELLOW },
    { vehGreenAxis: -1, vehYellow: false, pedWalkAxis: 2, duration: SCRAMBLE },
  ];
}

export class SignalSystem {
  readonly nodeIds: number[] = [];
  private signalOf: Int32Array;
  private mode: Uint8Array; private step: Uint8Array; private timer: Float32Array;
  private programs: PhaseStep[][] = [concurrentProgram(), scrambleProgram()];

  constructor(net: RoadNetwork, seed = 20240521, scrambleFraction = 0.15) {
    this.signalOf = new Int32Array(net.nodes.length).fill(-1);
    for (const n of net.nodes)
      if (n.hasSignal && n.edges.length >= 3) {
        this.signalOf[n.id] = this.nodeIds.length;
        this.nodeIds.push(n.id);
      }
    const cnt = this.nodeIds.length;
    const rng = makeRng(seed);
    this.mode = new Uint8Array(cnt); this.step = new Uint8Array(cnt); this.timer = new Float32Array(cnt);
    for (let k = 0; k < cnt; k++) {
      this.mode[k] = rng() < scrambleFraction ? SignalMode.Scramble : SignalMode.Concurrent;
      const prog = this.programs[this.mode[k]];
      this.step[k] = Math.floor(rng() * prog.length);
      this.timer[k] = rng() * prog[this.step[k]].duration;
    }
  }

  get count(): number { return this.nodeIds.length; }
  modeOf(node: number): SignalMode | null {
    const s = this.signalOf[node];
    return s < 0 ? null : (this.mode[s] as SignalMode);
  }
  update(dt: number): void {
    for (let k = 0; k < this.nodeIds.length; k++) {
      const prog = this.programs[this.mode[k]];
      this.timer[k] += dt;
      if (this.timer[k] >= prog[this.step[k]].duration) {
        this.timer[k] = 0;
        this.step[k] = (this.step[k] + 1) % prog.length;
      }
    }
  }
  private cur(node: number): PhaseStep | null {
    const s = this.signalOf[node];
    return s < 0 ? null : this.programs[this.mode[s]][this.step[s]];
  }
  vehicleGreen(node: number, axis: 0 | 1): boolean {
    const st = this.cur(node); if (!st) return true;
    return st.vehGreenAxis === axis && !st.vehYellow;
  }
  vehicleColor(node: number, axis: 0 | 1): 'green' | 'yellow' | 'red' | null {
    const st = this.cur(node); if (!st) return null;
    if (st.vehGreenAxis === axis) return st.vehYellow ? 'yellow' : 'green';
    return 'red';
  }
  pedWalk(node: number, axis: 0 | 1): boolean {
    const st = this.cur(node); if (!st) return true;
    return st.pedWalkAxis === axis || st.pedWalkAxis === 2;
  }
  pedColor(node: number, axis: 0 | 1): 'walk' | 'dont' | null {
    const st = this.cur(node); if (!st) return null;
    return (st.pedWalkAxis === axis || st.pedWalkAxis === 2) ? 'walk' : 'dont';
  }
}
