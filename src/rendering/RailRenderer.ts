import * as THREE from 'three';
import { RailLine, RailNetworkPlan, RailStationKind } from '../generation/RailPlanning';

interface StaticPart { matrix: THREE.Matrix4; }
interface TrainRun { lineId: number; phaseOffset: number; speed: number; }

/** City Generator v2 Phase 4: 高架鉄道・駅・簡易列車の描画。 */
export class RailRenderer {
  static readonly TRACK_Y = 8.2;
  private readonly trainRuns: TrainRun[] = [];
  private readonly d = new THREE.Object3D();
  private trainBody: THREE.InstancedMesh | null = null;
  private trainCabin: THREE.InstancedMesh | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly rail: RailNetworkPlan) {}

  build(): void {
    if (this.rail.lines.length === 0) return;
    const ballast: StaticPart[] = [], rails: StaticPart[] = [], sleepers: StaticPart[] = [], supports: StaticPart[] = [];

    for (const line of this.rail.lines) {
      for (let i = 1; i < line.path.length; i++) {
        const a = line.path[i - 1], b = line.path[i];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz); if (len < 0.5) continue;
        const ux = dx / len, uz = dz / len, px = -uz, pz = ux, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const angle = -Math.atan2(dz, dx);
        ballast.push({ matrix: this.matrix(mx, RailRenderer.TRACK_Y, mz, len + 0.4, 0.32, 3.8, angle) });
        for (const side of [-1, 1]) {
          rails.push({ matrix: this.matrix(mx + px * 0.82 * side, RailRenderer.TRACK_Y + 0.28, mz + pz * 0.82 * side, len + 0.25, 0.15, 0.13, angle) });
        }
      }

      const sleeperSpacing = 11;
      for (let s = 0; s <= line.length; s += sleeperSpacing) {
        const p = this.sampleLine(line, s); if (!p) continue;
        sleepers.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y + 0.17, p.z, 0.18, 0.12, 3.1, -p.heading) });
      }
      const supportSpacing = 72;
      for (let s = supportSpacing * 0.5; s < line.length; s += supportSpacing) {
        const p = this.sampleLine(line, s); if (!p) continue;
        supports.push({ matrix: this.matrix(p.x, RailRenderer.TRACK_Y * 0.5, p.z, 0.62, RailRenderer.TRACK_Y, 0.62) });
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x54504a, roughness: 0.98 }), sleepers);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x8a8f92, roughness: 0.88 }), supports);
    this.buildStations();
    this.buildTrains();
  }

  update(simSeconds: number): void {
    if (!this.trainBody || !this.trainCabin || this.trainRuns.length === 0) return;
    let count = 0;
    for (const run of this.trainRuns) {
      const line = this.rail.lines[run.lineId]; if (!line || line.length < 10) continue;
      const cycle = line.length * 2;
      let phase = (simSeconds * run.speed + run.phaseOffset) % cycle; if (phase < 0) phase += cycle;
      const forward = phase <= line.length;
      const distance = forward ? phase : cycle - phase;
      const p = this.sampleLine(line, distance); if (!p) continue;
      const heading = forward ? p.heading : p.heading + Math.PI;
      this.pose(this.trainBody, count, p.x, RailRenderer.TRACK_Y + 1.85, p.z, heading, 25, 3.15, 2.9);
      this.pose(this.trainCabin, count, p.x, RailRenderer.TRACK_Y + 3.28, p.z, heading, 18.5, 0.72, 2.45);
      count++;
    }
    this.trainBody.count = count; this.trainCabin.count = count;
    this.trainBody.instanceMatrix.needsUpdate = true; this.trainCabin.instanceMatrix.needsUpdate = true;
  }

  private buildStations(): void {
    const platforms: StaticPart[] = [], roofs: StaticPart[] = [], signs: StaticPart[] = [], columns: StaticPart[] = [];
    for (const station of this.rail.stations) {
      const heading = this.stationHeading(station.id);
      const major = station.kind === RailStationKind.Central || station.kind === RailStationKind.SubCenter;
      const platformLength = station.kind === RailStationKind.Central ? 62 : major ? 52 : 42;
      const platformWidth = major ? 6.5 : 5.2;
      platforms.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 0.38, station.z, platformLength, 0.38, platformWidth, -heading) });
      roofs.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 3.25, station.z, platformLength * 0.72, 0.18, platformWidth * 0.82, -heading) });
      signs.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y + 4.05, station.z, major ? 5.5 : 3.8, 1.25, 0.22, -heading) });
      columns.push({ matrix: this.matrix(station.x, RailRenderer.TRACK_Y * 0.5, station.z, major ? 1.1 : 0.8, RailRenderer.TRACK_Y, major ? 1.1 : 0.8) });
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.86 }), platforms);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x6f7d88, roughness: 0.58, metalness: 0.18 }), roofs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x2f6fa3, roughness: 0.52 }), signs);
    this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x777d82, roughness: 0.9 }), columns);
  }

  private buildTrains(): void {
    for (const line of this.rail.lines) {
      if (line.length < 300) continue;
      const count = line.kind === 'trunk' ? (line.length > 4500 ? 3 : 2) : 1;
      for (let i = 0; i < count; i++) {
        this.trainRuns.push({ lineId: line.id, phaseOffset: (line.length * 2 * i) / count, speed: line.kind === 'trunk' ? 21.5 : 17.0 });
      }
    }
    if (this.trainRuns.length === 0) return;
    const cap = this.trainRuns.length;
    this.trainBody = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe5e8eb, roughness: 0.48, metalness: 0.12 }),
      cap,
    );
    this.trainCabin = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x304d66, roughness: 0.25, metalness: 0.18 }),
      cap,
    );
    for (const mesh of [this.trainBody, this.trainCabin]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh);
    }
  }

  private stationHeading(stationId: number): number {
    const station = this.rail.stations[stationId];
    for (const lineId of station.lineIds) {
      const line = this.rail.lines[lineId], idx = line.stationIds.indexOf(stationId); if (idx < 0) continue;
      const otherId = idx + 1 < line.stationIds.length ? line.stationIds[idx + 1] : idx > 0 ? line.stationIds[idx - 1] : -1;
      if (otherId >= 0) {
        const other = this.rail.stations[otherId]; return Math.atan2(other.z - station.z, other.x - station.x);
      }
    }
    return 0;
  }

  private sampleLine(line: RailLine, distance: number): { x: number; z: number; heading: number } | null {
    if (line.path.length < 2 || line.length <= 0) return null;
    const d = THREE.MathUtils.clamp(distance, 0, line.length);
    let hi = 1;
    while (hi < line.cumulative.length && line.cumulative[hi] < d) hi++;
    hi = Math.min(hi, line.path.length - 1); const lo = Math.max(0, hi - 1);
    const a = line.path[lo], b = line.path[hi], start = line.cumulative[lo], end = line.cumulative[hi];
    const t = end > start ? (d - start) / (end - start) : 0;
    return { x: THREE.MathUtils.lerp(a.x, b.x, t), z: THREE.MathUtils.lerp(a.z, b.z, t), heading: Math.atan2(b.z - a.z, b.x - a.x) };
  }

  private pose(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number): void {
    this.d.position.set(x, y, z); this.d.rotation.set(0, -heading, 0); this.d.scale.set(sx, sy, sz); this.d.updateMatrix(); mesh.setMatrixAt(index, this.d.matrix);
  }

  private matrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0): THREE.Matrix4 {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)), new THREE.Vector3(sx, sy, sz));
  }

  private addStatic(geometry: THREE.BufferGeometry, material: THREE.Material, parts: StaticPart[]): THREE.InstancedMesh | null {
    if (parts.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, parts.length);
    parts.forEach((p, i) => mesh.setMatrixAt(i, p.matrix)); mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
  }
}
