import { VehicleStore, VehicleState } from './VehicleStore';
import { TrafficSystem } from './TrafficSystem';
import { POIRegistry, POI } from '../world/POI';
import { makeRng } from '../core/math';
type Phase = 'idle' | 'toStore' | 'unloading' | 'returning';
interface Truck { vehicle: number; gate: number; gateX: number; gateZ: number; phase: Phase; cargo: number; capacity: number; route: number[]; routeIdx: number; unloadT: number; }
/** 外部ゲート→店舗の商品物流(配送トラック)。既存IDMで走行。 */
export class LogisticsSystem {
  private trucks: Truck[] = [];
  private rng: () => number;
  readonly unloadSeconds = 6;
  constructor(private vs: VehicleStore, private traffic: TrafficSystem, private poi: POIRegistry, private gates: { node: number; x: number; z: number }[], seed = 555) { this.rng = makeRng(seed); }
  build(trucksPerGate = 2): void {
    for (const g of this.gates) for (let k = 0; k < trucksPerGate; k++) { const v = this.vs.spawnTruck(this.trucks.length, g.x, g.z); if (v < 0) return; this.trucks.push({ vehicle: v, gate: g.node, gateX: g.x, gateZ: g.z, phase: 'idle', cargo: 0, capacity: 200, route: [], routeIdx: 0, unloadT: 0 }); }
  }
  update(dt: number): void {
    const vs = this.vs;
    for (let t = 0; t < this.trucks.length; t++) {
      const tr = this.trucks[t]; const v = tr.vehicle;
      switch (tr.phase) {
        case 'idle': { const targets = this.pickTargets(tr.gateX, tr.gateZ, 6); if (targets.length === 0) break; tr.route = targets; tr.routeIdx = 0; tr.cargo = tr.capacity; this.goToNextStore(tr); break; }
        case 'toStore': { if (vs.state[v] === VehicleState.Arrived) { tr.phase = 'unloading'; tr.unloadT = this.unloadSeconds; vs.speed[v] = 0; } break; }
        case 'unloading': { tr.unloadT -= dt; if (tr.unloadT <= 0) { const store = this.poi.get(tr.route[tr.routeIdx]); const need = store.maxStock - store.stock; const give = Math.min(need, tr.cargo); store.stock += give; tr.cargo -= give; tr.routeIdx++; if (tr.routeIdx >= tr.route.length || tr.cargo <= 0) this.returnToGate(tr); else this.goToNextStore(tr); } break; }
        case 'returning': { if (vs.state[v] === VehicleState.Arrived) { tr.phase = 'idle'; vs.speed[v] = 0; vs.posX[v] = tr.gateX; vs.posZ[v] = tr.gateZ; } break; }
      }
    }
  }
  private pickTargets(gx: number, gz: number, n: number): number[] {
    const list = this.poi.all(); const cand: { id: number; d: number }[] = [];
    for (const p of list) { if (p.maxStock <= 0) continue; if (p.stock >= p.maxStock * 0.6) continue; const d = (p.x - gx) ** 2 + (p.z - gz) ** 2; cand.push({ id: p.id, d }); }
    cand.sort((a, b) => a.d - b.d);
    const out: number[] = []; for (let i = 0; i < cand.length && out.length < n; i++) if (this.rng() < 0.85) out.push(cand[i].id);
    return out;
  }
  private goToNextStore(tr: Truck): void {
    const store: POI = this.poi.get(tr.route[tr.routeIdx]);
    if (!this.traffic.dispatch(tr.vehicle, this.vs.posX[tr.vehicle], this.vs.posZ[tr.vehicle], store.x, store.z)) { tr.routeIdx++; if (tr.routeIdx >= tr.route.length) this.returnToGate(tr); else this.goToNextStore(tr); return; }
    tr.phase = 'toStore';
  }
  private returnToGate(tr: Truck): void {
    if (!this.traffic.dispatch(tr.vehicle, this.vs.posX[tr.vehicle], this.vs.posZ[tr.vehicle], tr.gateX, tr.gateZ)) { this.vs.posX[tr.vehicle] = tr.gateX; this.vs.posZ[tr.vehicle] = tr.gateZ; this.vs.state[tr.vehicle] = VehicleState.Arrived; }
    tr.phase = 'returning';
  }
  get truckCount(): number { return this.trucks.length; }
  truckPhase(id: number): string { return this.trucks[id].phase; }
  truckCargo(id: number): number { return this.trucks[id].cargo; }
  truckCapacity(id: number): number { return this.trucks[id].capacity; }
}
