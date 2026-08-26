import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';
import './RailStationOperationsTuning';

type AnyRail = Record<string, any>;
type TrackLane = -1 | 0 | 1;

const proto = RailRenderer.prototype as unknown as AnyRail;

/**
 * 駅ホーム内の閉塞境界は運転上は有効なまま、信号機だけを仮想化する。
 * ホーム中央へ独立柱の信号機を立てると旅客導線・屋根と干渉するため、
 * 物理信号はホーム外の閉塞境界だけに設置する。
 */
function insidePlatform(self: AnyRail, smooth: AnyRail, line: AnyRail, distance: number): boolean {
  for (let i = 0; i < line.stationIds.length; i++) {
    const center = smooth.stationDistances[i];
    if (!Number.isFinite(center)) continue;
    const stationId = line.stationIds[i];
    const length = self.platformLength(stationId) as number;
    if (!Number.isFinite(length) || length <= 0) continue;
    if (Math.abs(distance - center) <= length * 0.5 + 2.0) return true;
  }
  return false;
}

proto.buildRailSignals = function platformClearRailSignals(this: AnyRail): void {
  const poles: { matrix: THREE.Matrix4 }[] = [];
  const heads: { matrix: THREE.Matrix4 }[] = [];
  this.railSignals.length = 0;

  for (const block of this.blocks as AnyRail[]) {
    const line = this.rail.lines[block.lineId]; if (!line) continue;
    const smooth = this.smoothLines.get(block.lineId) as AnyRail | undefined; if (!smooth) continue;

    const normalDirection: 1 | -1 = line.kind === 'trunk' ? (block.lane < 0 ? 1 : -1) : 1;
    const directions: (1 | -1)[] = line.kind === 'trunk' ? [normalDirection] : [1, -1];

    for (const direction of directions) {
      const d = direction > 0 ? block.startD : block.endD;
      if (insidePlatform(this, smooth, line, d)) continue;

      const p = this.sampleSmooth(smooth, d); if (!p) continue;
      const off = this.trackOffsetAt(smooth, block.lane as TrackLane, d) as number;
      const side = direction > 0 ? -2.35 : 2.35;
      const x = p.x - Math.sin(p.heading) * (off + side);
      const z = p.z + Math.cos(p.heading) * (off + side);
      const y = this.lineTrackY(block.lineId) as number;

      poles.push({ matrix: this.matrix(x, y + 1.65, z, 0.18, 3.3, 0.18) });
      heads.push({ matrix: this.matrix(x, y + 3.45, z, 0.82, 2.08, 0.68, -p.heading + Math.PI / 2) });

      const nextBlockId = this.nextBlockAfter(block.id, direction) as number;
      this.railSignals.push({ lineId: block.lineId, lane: block.lane, direction, blockId: block.id, nextBlockId, instanceIndex: this.railSignals.length, x, y, z, heading: p.heading });
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4c5156, roughness: 0.7 }), poles);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.75 }), heads);

  const count = this.railSignals.length as number;
  if (!count) return;
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  this.signalRed = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xff3030 }), count * 2);
  this.signalYellow = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xffd23c }), count * 2);
  this.signalGreen = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0x39ef73 }), count * 2);
  for (const mesh of [this.signalRed, this.signalYellow, this.signalGreen] as THREE.InstancedMesh[]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }
};
