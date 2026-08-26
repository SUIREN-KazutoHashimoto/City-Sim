import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type TrackLane = -1 | 0 | 1;
type SignalAspect = 'red' | 'yellow' | 'green';

interface PlatformIndicator {
  lineId: number;
  stationIndex: number;
  stationId: number;
  lane: TrackLane | null;
  terminalSlot: number;
  departureIndex: number;
  approachIndex: number;
  departureMatrix: THREE.Matrix4;
  approachMatrix: THREE.Matrix4;
}

interface TrainEndInstances {
  first: number;
  last: number;
}

const TERMINAL_TRACK_OFFSETS = [-9.5, -1.9, 1.9, 9.5] as const;
const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRACK_LIGHT_SPACING = 115;
const APPROACH_NOTICE_DISTANCE = 280;
const TRAIN_LAMP_LATERAL = 0.68;
const TRAIN_LAMP_FORWARD = 0.06;
const TRAIN_LAMP_VERTICAL = 0.18;

const proto = RailRenderer.prototype as unknown as AnyRail;
const originalBuildTrackGeometry = proto.buildTrackGeometry as () => void;
const originalBuildStations = proto.buildStations as () => void;
const originalBuildTrains = proto.buildTrains as () => void;
const originalUpdate = proto.update as (realDt?: number, timeScale?: number, paused?: boolean) => void;

function terminalPlatformSlot(self: AnyRail, run: AnyRun, stationIndex: number): number {
  const line = self.rail.lines[run.lineId];
  const stationId = line?.stationIds[stationIndex] ?? 0;
  const raw = run.id * 3 + stationId * 5 + run.depotTrack;
  return ((raw % 4) + 4) % 4;
}

function directionForPlan(plan: AnyRail | undefined, run: AnyRun): 1 | -1 {
  if (plan && Number.isFinite(plan.fromIndex) && Number.isFinite(plan.toIndex)) return plan.toIndex > plan.fromIndex ? 1 : -1;
  return run.direction as 1 | -1;
}

/**
 * 信号は「信号直後の閉塞」の状態を表示する。
 * 同方向・同線路の列車が予約済みなら、その予約は当該信号に対して進行可能扱い。
 */
function blockClearForSignal(self: AnyRail, blockId: number, signal: AnyRail): boolean {
  if (blockId < 0) return true;
  const block = self.blocks[blockId];
  if (!block) return true;
  for (const conflictId of block.conflicts as Set<number>) {
    const occupied = self.blockOccupancy.get(conflictId);
    if (occupied != null) return false;

    const reserved = self.blockReservations.get(conflictId);
    if (reserved == null) continue;
    const owner = self.trainRuns[reserved] as AnyRun | undefined;
    if (!owner) return false;
    const plan = self.plannedRoutes.get(reserved) as AnyRail | undefined;
    const ownerDirection = directionForPlan(plan, owner);
    const ownerLane = (plan?.lane ?? owner.lane) as TrackLane;
    if (owner.lineId === signal.lineId && ownerLane === signal.lane && ownerDirection === signal.direction) continue;
    return false;
  }
  return true;
}

proto.signalAspect = function nextBlockSignalAspect(this: AnyRail, signal: AnyRail): SignalAspect {
  // signal.blockId は信号機の直後にある制御対象閉塞。
  if (!blockClearForSignal(this, signal.blockId, signal)) return 'red';
  if (signal.nextBlockId >= 0 && !blockClearForSignal(this, signal.nextBlockId, signal)) return 'yellow';
  return 'green';
};

proto.buildTrackGeometry = function litTrackGeometry(this: AnyRail): void {
  originalBuildTrackGeometry.call(this);

  const poles: { matrix: THREE.Matrix4 }[] = [];
  const lamps: { matrix: THREE.Matrix4 }[] = [];
  for (const smooth of this.smoothLines.values() as Iterable<AnyRail>) {
    const y = this.lineTrackY(smooth.line.id) as number;
    for (let d = 48, n = 0; d < smooth.length - 30; d += TRACK_LIGHT_SPACING, n++) {
      const p = this.sampleSmooth(smooth, d); if (!p) continue;
      const side = (n & 1) === 0 ? 1 : -1;
      const lateral = smooth.line.kind === 'trunk' ? side * 4.8 : side * 3.6;
      const x = p.x - Math.sin(p.heading) * lateral;
      const z = p.z + Math.cos(p.heading) * lateral;
      poles.push({ matrix: this.matrix(x, y + 1.9, z, 0.15, 3.8, 0.15) });
      lamps.push({ matrix: this.matrix(x, y + 3.92, z, 0.52, 0.16, 0.28, -p.heading) });
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x59626a, roughness: 0.78, metalness: 0.25 }), poles);
  this.addStatic(box, new THREE.MeshBasicMaterial({ color: 0xd9ecff }), lamps);
};

function platformOffsets(self: AnyRail, line: AnyRail, smooth: AnyRail, stationIndex: number): Array<{ offset: number; lane: TrackLane | null; slot: number }> {
  const stationId = line.stationIds[stationIndex];
  const station = self.rail.stations[stationId];
  if (station?.kind === RailStationKind.Terminal && (stationIndex === 0 || stationIndex === line.stationIds.length - 1)) {
    return TERMINAL_TRACK_OFFSETS.map((offset, slot) => ({ offset, lane: null, slot }));
  }
  if (line.kind === 'trunk') {
    const island = self.lineStationHasPassingLoop(line.id, stationIndex)
      ? (MAIN_OFFSET + SIDING_OFFSET) * 0.5
      : 5.0;
    return [
      { offset: -island, lane: -1, slot: -1 },
      { offset: island, lane: 1, slot: -1 },
    ];
  }
  const track = self.sharedSpurOffset(smooth, smooth.stationDistances[stationIndex] ?? 0) as number;
  const side = track >= 0 ? 1 : -1;
  return [{ offset: track + side * 3.2, lane: 0, slot: -1 }];
}

proto.buildStations = function litStations(this: AnyRail): void {
  originalBuildStations.call(this);

  const poles: { matrix: THREE.Matrix4 }[] = [];
  const lamps: { matrix: THREE.Matrix4 }[] = [];
  const indicators: PlatformIndicator[] = [];

  for (const line of this.rail.lines as AnyRail[]) {
    const smooth = this.smoothLines.get(line.id) as AnyRail | undefined; if (!smooth) continue;
    const y = this.lineTrackY(line.id) as number;
    for (let stationIndex = 0; stationIndex < line.stationIds.length; stationIndex++) {
      const stationId = line.stationIds[stationIndex];
      const center = smooth.stationDistances[stationIndex] ?? 0;
      const length = this.platformLength(stationId) as number;
      const offsets = platformOffsets(this, line, smooth, stationIndex);

      for (const platform of offsets) {
        for (let along = -length * 0.38; along <= length * 0.38; along += 18) {
          const p = this.offsetPoint(smooth, THREE.MathUtils.clamp(center + along, 0, smooth.length), platform.offset);
          if (!p) continue;
          poles.push({ matrix: this.matrix(p.x, y + 2.15, p.z, 0.13, 4.3, 0.13) });
          lamps.push({ matrix: this.matrix(p.x, y + 4.38, p.z, 1.25, 0.16, 0.30, -p.heading) });
        }

        const guideD = THREE.MathUtils.clamp(center + (stationIndex === line.stationIds.length - 1 ? -1 : 1) * Math.min(22, length * 0.28), 0, smooth.length);
        const guide = this.offsetPoint(smooth, guideD, platform.offset); if (!guide) continue;
        const base = indicators.length;
        indicators.push({
          lineId: line.id,
          stationIndex,
          stationId,
          lane: platform.lane,
          terminalSlot: platform.slot,
          departureIndex: base,
          approachIndex: base,
          departureMatrix: this.matrix(guide.x, y + 3.65, guide.z, 0.62, 0.34, 0.22, -guide.heading),
          approachMatrix: this.matrix(guide.x, y + 3.13, guide.z, 0.62, 0.34, 0.22, -guide.heading),
        });
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x6c7378, roughness: 0.74, metalness: 0.20 }), poles);
  this.addStatic(box, new THREE.MeshBasicMaterial({ color: 0xfff2c7 }), lamps);

  this.platformIndicators = indicators;
  if (!indicators.length) return;
  this.platformDepartureLights = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    indicators.length,
  );
  this.platformApproachLights = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    indicators.length,
  );
  for (const indicator of indicators) {
    this.platformDepartureLights.setMatrixAt(indicator.departureIndex, indicator.departureMatrix);
    this.platformApproachLights.setMatrixAt(indicator.approachIndex, indicator.approachMatrix);
    this.platformDepartureLights.setColorAt(indicator.departureIndex, new THREE.Color(0x193225));
    this.platformApproachLights.setColorAt(indicator.approachIndex, new THREE.Color(0x3a2b16));
  }
  for (const mesh of [this.platformDepartureLights, this.platformApproachLights] as THREE.InstancedMesh[]) {
    mesh.frustumCulled = false;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
  }
};

function buildTrainEndInstanceMap(self: AnyRail): Map<number, TrainEndInstances> {
  const map = new Map<number, TrainEndInstances>();
  const instanceToRun = self.trainInstanceToRun as number[];
  for (let instance = 0; instance < instanceToRun.length; instance++) {
    const runId = instanceToRun[instance];
    if (runId == null || runId < 0) continue;
    const current = map.get(runId);
    if (!current) map.set(runId, { first: instance, last: instance });
    else current.last = instance;
  }
  return map;
}

function hideTrainLamp(self: AnyRail, mesh: THREE.InstancedMesh, index: number): void {
  mesh.setMatrixAt(index, self.matrix(0, -1000, 0, 0.01, 0.01, 0.01));
}

proto.buildTrains = function litTrains(this: AnyRail): void {
  originalBuildTrains.call(this);
  const count = this.trainRuns.length as number;
  if (!count) return;

  this.trainEndInstances = buildTrainEndInstanceMap(this);
  const box = new THREE.BoxGeometry(1, 1, 1);
  this.trainHeadLights = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xfff7d5 }), count * 2);
  this.trainTailLights = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xff3131 }), count * 2);
  for (const mesh of [this.trainHeadLights, this.trainTailLights] as THREE.InstancedMesh[]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    for (let i = 0; i < count * 2; i++) hideTrainLamp(this, mesh, i);
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }
};

function platformMatchesRun(self: AnyRail, indicator: PlatformIndicator, run: AnyRun): boolean {
  if (run.lineId !== indicator.lineId) return false;
  if (indicator.terminalSlot >= 0) return terminalPlatformSlot(self, run, indicator.stationIndex) === indicator.terminalSlot;
  if (indicator.lane != null && self.rail.lines[run.lineId]?.kind === 'trunk') return run.lane === indicator.lane;
  return true;
}

function updatePlatformIndicators(self: AnyRail): void {
  const indicators = self.platformIndicators as PlatformIndicator[] | undefined;
  const departure = self.platformDepartureLights as THREE.InstancedMesh | undefined;
  const approach = self.platformApproachLights as THREE.InstancedMesh | undefined;
  if (!indicators || !departure || !approach) return;

  const blink = Math.floor(self.railTime * 2) % 2 === 0;
  for (const indicator of indicators) {
    let departureReady = false;
    let approaching = false;

    for (const run of self.trainRuns as AnyRun[]) {
      if (!platformMatchesRun(self, indicator, run) || run.state === 'depot') continue;
      if (run.currentStationIndex === indicator.stationIndex) {
        const routeSet = self.plannedRoutes.has(run.id);
        const secondsToDeparture = run.scheduledDepartureAt - self.railTime;
        if (routeSet || (run.dwellRemaining <= 6 && secondsToDeparture <= 12)) departureReady = true;
      }
      if (run.state === 'running' && run.nextStationIndex === indicator.stationIndex && self.shouldStop(run, indicator.stationIndex)) {
        const smooth = self.smoothLines.get(run.lineId); if (!smooth) continue;
        const stationD = smooth.stationDistances[indicator.stationIndex] ?? run.distance;
        if (Math.abs(stationD - run.distance) <= APPROACH_NOTICE_DISTANCE) approaching = true;
      }
    }

    departure.setColorAt(indicator.departureIndex, new THREE.Color(departureReady ? 0x4dff91 : 0x193225));
    approach.setColorAt(indicator.approachIndex, new THREE.Color(approaching && blink ? 0xffb32d : 0x3a2b16));
  }
  if (departure.instanceColor) departure.instanceColor.needsUpdate = true;
  if (approach.instanceColor) approach.instanceColor.needsUpdate = true;
}

function placeLampPair(
  mesh: THREE.InstancedMesh,
  baseIndex: number,
  matrix: THREE.Matrix4,
  frontFace: boolean,
): void {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);

  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize();
  const lateral = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  const faceSign = frontFace ? 1 : -1;
  const faceCenter = position.clone()
    .addScaledVector(forward, faceSign * (Math.abs(scale.x) * 0.5 + TRAIN_LAMP_FORWARD));
  faceCenter.y += TRAIN_LAMP_VERTICAL;

  for (let side = 0; side < 2; side++) {
    const lampPosition = faceCenter.clone().addScaledVector(lateral, side === 0 ? -TRAIN_LAMP_LATERAL : TRAIN_LAMP_LATERAL);
    const lampMatrix = new THREE.Matrix4().compose(
      lampPosition,
      quaternion,
      new THREE.Vector3(0.10, 0.20, 0.22),
    );
    mesh.setMatrixAt(baseIndex + side, lampMatrix);
  }
}

function updateTrainLights(self: AnyRail): void {
  const heads = self.trainHeadLights as THREE.InstancedMesh | undefined;
  const tails = self.trainTailLights as THREE.InstancedMesh | undefined;
  const body = self.trainBody as THREE.InstancedMesh | undefined;
  const ends = self.trainEndInstances as Map<number, TrainEndInstances> | undefined;
  if (!heads || !tails || !body || !ends) return;

  const frontMatrix = new THREE.Matrix4();
  const rearMatrix = new THREE.Matrix4();

  for (const run of self.trainRuns as AnyRun[]) {
    const base = (run.id as number) * 2;
    const end = ends.get(run.id);
    if (run.state === 'depot' || !end) {
      hideTrainLamp(self, heads, base);
      hideTrainLamp(self, heads, base + 1);
      hideTrainLamp(self, tails, base);
      hideTrainLamp(self, tails, base + 1);
      continue;
    }

    // trainBodyの各車両行列が実描画位置そのもの。
    // 進行方向が正ならcar0側、負なら最終car側が先頭になる。
    const frontInstance = run.direction > 0 ? end.first : end.last;
    const rearInstance = run.direction > 0 ? end.last : end.first;
    body.getMatrixAt(frontInstance, frontMatrix);
    body.getMatrixAt(rearInstance, rearMatrix);
    placeLampPair(heads, base, frontMatrix, true);
    placeLampPair(tails, base, rearMatrix, false);
  }
  heads.instanceMatrix.needsUpdate = true;
  tails.instanceMatrix.needsUpdate = true;
}

proto.update = function updateRailLighting(this: AnyRail, realDt?: number, timeScale?: number, paused?: boolean): void {
  originalUpdate.call(this, realDt, timeScale, paused);
  updateTrainLights(this);
  updatePlatformIndicators(this);
};
