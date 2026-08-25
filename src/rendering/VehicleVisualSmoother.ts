import * as THREE from 'three';
import '../traffic/TrafficTurningTuning';
import { VehicleStore } from '../traffic/VehicleStore';

/**
 * Simulation batch間で飛ぶVehicle poseを実時間で補間する表示専用レイヤー。
 * apply/restore中だけVehicleStoreのpose配列を表示値へ差し替えるため、交通シミュレーション自体には影響しない。
 */
export class VehicleVisualSmoother {
  private readonly x: Float32Array; private readonly z: Float32Array; private readonly heading: Float32Array; private readonly initialized: Uint8Array;
  private readonly rawX: Float32Array; private readonly rawZ: Float32Array; private readonly rawHeading: Float32Array;
  private applied = false; private appliedCount = 0;

  constructor(capacity: number) {
    this.x = new Float32Array(capacity); this.z = new Float32Array(capacity); this.heading = new Float32Array(capacity); this.initialized = new Uint8Array(capacity);
    this.rawX = new Float32Array(capacity); this.rawZ = new Float32Array(capacity); this.rawHeading = new Float32Array(capacity);
  }

  private angleDelta(from: number, to: number): number {
    let d = to - from; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d;
  }

  update(vs: VehicleStore, dt: number): void {
    // The traffic layer now supplies a continuous corner arc. Keep render interpolation responsive
    // enough that heading does not visibly lag behind the curved position and look like side-slip.
    const posAlpha = 1 - Math.exp(-Math.max(0, dt) * 11);
    const rotAlpha = 1 - Math.exp(-Math.max(0, dt) * 13);
    for (let v = 0; v < vs.count; v++) {
      const tx = vs.posX[v], tz = vs.posZ[v], th = vs.heading[v];
      const dx = tx - this.x[v], dz = tz - this.z[v];
      if (!this.initialized[v] || dx * dx + dz * dz > 80 * 80) {
        this.x[v] = tx; this.z[v] = tz; this.heading[v] = th; this.initialized[v] = 1; continue;
      }
      this.x[v] += dx * posAlpha; this.z[v] += dz * posAlpha;
      this.heading[v] += this.angleDelta(this.heading[v], th) * rotAlpha;
    }
  }

  getPose(v: number, vs: VehicleStore, out: THREE.Vector3): number {
    if (v < 0 || v >= vs.count || !this.initialized[v]) { out.set(vs.posX[v] ?? 0, 0, vs.posZ[v] ?? 0); return vs.heading[v] ?? 0; }
    out.set(this.x[v], 0, this.z[v]); return this.heading[v];
  }

  apply(vs: VehicleStore): void {
    if (this.applied) return; this.applied = true; this.appliedCount = vs.count;
    for (let v = 0; v < vs.count; v++) {
      this.rawX[v] = vs.posX[v]; this.rawZ[v] = vs.posZ[v]; this.rawHeading[v] = vs.heading[v];
      if (!this.initialized[v]) continue;
      vs.posX[v] = this.x[v]; vs.posZ[v] = this.z[v]; vs.heading[v] = this.heading[v];
    }
  }

  restore(vs: VehicleStore): void {
    if (!this.applied) return;
    for (let v = 0; v < this.appliedCount; v++) { vs.posX[v] = this.rawX[v]; vs.posZ[v] = this.rawZ[v]; vs.heading[v] = this.rawHeading[v]; }
    this.applied = false; this.appliedCount = 0;
  }
}
