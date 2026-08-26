import * as THREE from 'three';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type AnyPlan = Record<string, any>;
type TrackLane = -1 | 0 | 1;

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;

const proto = RailRenderer.prototype as unknown as AnyRail;
const originalBuildTrains = proto.buildTrains as () => void;
const originalRebuildDispatchReservations = proto.rebuildDispatchReservations as () => void;
const originalEnterPlannedRoute = proto.enterPlannedRoute as (run: AnyRun, plan: AnyPlan) => void;
const originalTryReleaseDepotTrain = proto.tryReleaseDepotTrain as (run: AnyRun) => void;
const originalRouteKeysForPlan = proto.routeKeysForPlan as (run: AnyRun, fromIndex: number, toIndex: number, lane: TrackLane) => string[];

function rightHandLane(direction: 1 | -1): TrackLane {
  // pathの正方向で+offsetは進行方向左側。したがって右側線は-direction。
  return (-direction) as TrackLane;
}

function travelDirection(fromIndex: number, toIndex: number): 1 | -1 {
  return toIndex > fromIndex ? 1 : -1;
}

function intervalIndex(fromIndex: number, toIndex: number): number {
  return Math.min(fromIndex, toIndex);
}

function wrongWayOccupiesInterval(self: AnyRail, run: AnyRun, fromIndex: number, toIndex: number, lane: TrackLane): boolean {
  const interval = intervalIndex(fromIndex, toIndex);
  return self.trainRuns.some((other: AnyRun) => {
    if (other.id === run.id || other.state !== 'running' || other.lineId !== run.lineId || other.lane !== lane) return false;
    if (other.originStationIndex < 0 || other.nextStationIndex < 0) return false;
    if (intervalIndex(other.originStationIndex, other.nextStationIndex) !== interval) return false;
    const normal = rightHandLane(other.direction as 1 | -1);
    return other.lane !== normal;
  });
}

proto.buildTrains = function patchedBuildTrains(this: AnyRail): void {
  originalBuildTrains.call(this);
  for (const run of this.trainRuns as AnyRun[]) {
    const line = this.rail.lines[run.lineId];
    if (line?.kind !== 'trunk') continue;
    run.lane = rightHandLane(run.direction as 1 | -1);
    run.previousLane = run.lane;
    run.laneChangeStationIndex = -1;
  }
};

proto.rebuildDispatchReservations = function patchedRebuildDispatchReservations(this: AnyRail): void {
  // 停車中は到着時のlaneを保持する。
  // 次方向の右側線へ先に切り替えると、車体が同一駅の別ホームへ瞬間移動して見える。
  // 必要な線路変更はenterPlannedRoute()で発車時にだけ開始する。
  originalRebuildDispatchReservations.call(this);
};

proto.routeKeysForPlan = function patchedRightHandRouteKeys(
  this: AnyRail, run: AnyRun, fromIndex: number, toIndex: number, lane: TrackLane,
): string[] {
  const oldDirection = run.direction;
  run.direction = travelDirection(fromIndex, toIndex);
  try {
    return originalRouteKeysForPlan.call(this, run, fromIndex, toIndex, lane);
  } finally {
    run.direction = oldDirection;
  }
};

proto.canUseCrossover = function patchedCanUseCrossover(this: AnyRail, run: AnyRun, fromIndex: number, toIndex: number): boolean {
  if (!this.hasCrossover(run.lineId, fromIndex) || !this.hasCrossover(run.lineId, toIndex)) return false;
  if (run.id === this.recoveryTrainId) return true;
  const waited = run.waitingSince >= 0 ? this.railTime - run.waitingSince : 0;
  if (run.service === 'limited') return waited >= 12;
  if (run.service === 'rapid') return waited >= 30;
  return waited >= 75;
};

proto.chooseRoutePlan = function patchedChooseRoutePlan(
  this: AnyRail, run: AnyRun, fromIndex: number, toIndex: number,
): AnyPlan | null {
  const line = this.rail.lines[run.lineId]; if (!line) return null;
  const direction = travelDirection(fromIndex, toIndex);
  const normal: TrackLane = line.kind === 'trunk' ? rightHandLane(direction) : 0;
  const candidates: TrackLane[] = [normal];
  if (line.kind === 'trunk' && this.canUseCrossover(run, fromIndex, toIndex)) candidates.push((-normal) as TrackLane);

  let best: AnyPlan | null = null;
  let bestScore = -Infinity;
  for (const lane of candidates) {
    const sequence = this.blockSequence(run.lineId, fromIndex, toIndex, lane) as number[];
    if (!sequence.length) continue;
    const reverseRunning = line.kind === 'trunk' && lane !== normal;

    // 反対線運転は駅間全体が空いているときだけ許可する。
    if (reverseRunning && !sequence.every((id) => this.blockAvailableFor(run.id, id))) continue;
    // 反対線運転中の列車と対向正規列車を同じ駅間へ入れない。
    if (!reverseRunning && wrongWayOccupiesInterval(this, run, fromIndex, toIndex, lane)) continue;

    const first = sequence[0];
    if (!this.blockAvailableFor(run.id, first)) continue;
    const reservation = this.blockReservations.get(first);
    if (reservation != null && reservation !== run.id) continue;
    if (!this.stationTrackAvailable(run, toIndex, lane)) continue;

    const routeKeys = this.routeKeysForPlan(run, fromIndex, toIndex, lane) as string[];
    if (!this.routesAvailableFor(run, routeKeys)) continue;
    let clear = 0;
    for (const id of sequence) {
      if (!this.blockFreeIgnoringOwnReservation(id, run.id)) break;
      clear++;
    }
    // 右側本線を強く優先。反対線は遅延回復用に限定する。
    const score = clear + (lane === normal ? 1.25 : -0.30) + this.servicePriority(run.service) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = { trainId: run.id, lineId: run.lineId, fromIndex, toIndex, lane, firstBlockId: first, routeKeys };
    }
  }
  return best;
};

proto.enterPlannedRoute = function patchedEnterPlannedRoute(this: AnyRail, run: AnyRun, plan: AnyPlan): void {
  const direction = travelDirection(plan.fromIndex, plan.toIndex);
  run.direction = direction;
  originalEnterPlannedRoute.call(this, run, plan);
  const line = this.rail.lines[run.lineId];
  if (!line || line.kind !== 'trunk') return;

  // 終端の4線ファン内では、停車ホームを保持したまま発車後に右側本線へ収束する。
  // terminal platform offsetが車体位置を保持するため、ここでは偽の渡線状態だけ消す。
  const stationId = line.stationIds[plan.fromIndex];
  const station = this.rail.stations[stationId];
  if (station?.kind === 3 && plan.lane === rightHandLane(direction)) {
    run.previousLane = plan.lane;
    run.lane = plan.lane;
    run.laneChangeStationIndex = -1;
  }
};

proto.tryReleaseDepotTrain = function patchedRightHandDepotRelease(this: AnyRail, run: AnyRun): void {
  originalTryReleaseDepotTrain.call(this, run);
  const line = this.rail.lines[run.lineId];
  if (run.state === 'depot' || line?.kind !== 'trunk') return;
  run.lane = rightHandLane(run.direction as 1 | -1);
  run.previousLane = run.lane;
  run.laneChangeStationIndex = -1;
};

proto.buildRailSignals = function patchedRightHandSignals(this: AnyRail): void {
  const poles: { matrix: THREE.Matrix4 }[] = [], heads: { matrix: THREE.Matrix4 }[] = [];
  this.railSignals.length = 0;
  for (const block of this.blocks) {
    const line = this.rail.lines[block.lineId]; if (!line) continue;
    // lane -1 はpath正方向の右側、lane +1 はpath逆方向の右側。
    const normalDirection: 1 | -1 = line.kind === 'trunk' ? (block.lane < 0 ? 1 : -1) : 1;
    const directions: (1 | -1)[] = line.kind === 'trunk' ? [normalDirection] : [1, -1];
    for (const direction of directions) {
      const d = direction > 0 ? block.startD : block.endD;
      const smooth = this.smoothLines.get(block.lineId);
      const p = smooth ? this.sampleSmooth(smooth, d) : null;
      if (!smooth || !p) continue;
      const off = this.trackOffsetAt(smooth, block.lane, d);
      const side = direction > 0 ? -2.35 : 2.35;
      const x = p.x - Math.sin(p.heading) * (off + side);
      const z = p.z + Math.cos(p.heading) * (off + side);
      const y = this.lineTrackY(block.lineId);
      poles.push({ matrix: this.matrix(x, y + 1.65, z, 0.18, 3.3, 0.18) });
      heads.push({ matrix: this.matrix(x, y + 3.45, z, 0.82, 2.08, 0.68, -p.heading + Math.PI / 2) });
      const nextBlockId = this.nextBlockAfter(block.id, direction);
      this.railSignals.push({
        lineId: block.lineId, lane: block.lane, direction, blockId: block.id, nextBlockId,
        instanceIndex: this.railSignals.length, x, y, z, heading: p.heading,
      });
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4c5156, roughness: 0.7 }), poles);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.75 }), heads);
  const count = this.railSignals.length; if (!count) return;
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  this.signalRed = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xff3030 }), count * 2);
  this.signalYellow = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0xffd23c }), count * 2);
  this.signalGreen = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ color: 0x39ef73 }), count * 2);
  for (const mesh of [this.signalRed, this.signalYellow, this.signalGreen]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }
};

proto.buildTurnoutIndicators = function patchedRightHandTurnoutIndicators(this: AnyRail): void {
  const box = new THREE.BoxGeometry(1, 1, 1);
  this.turnoutIndicators.length = 0;
  for (const line of this.rail.lines) {
    if (line.kind !== 'trunk') continue;
    const smooth = this.smoothLines.get(line.id); if (!smooth) continue;
    const y = this.lineTrackY(line.id) as number;
    for (let i = 0; i < line.stationIds.length; i++) {
      const stationId = line.stationIds[i];
      if (this.lineStationHasPassingLoop(line.id, i)) {
        for (const direction of [-1, 1] as const) {
          const d = THREE.MathUtils.clamp((smooth.stationDistances[i] ?? 0)
            - direction * (this.platformLength(stationId) / 2 + 16 + 20), 0, smooth.length);
          const p = this.sampleSmooth(smooth, d); if (!p) continue;
          const lane = rightHandLane(direction);
          for (const kind of ['main', 'siding'] as const) {
            const off = lane * (kind === 'main' ? MAIN_OFFSET : SIDING_OFFSET);
            const x = p.x - Math.sin(p.heading) * off;
            const z = p.z + Math.cos(p.heading) * off;
            this.turnoutIndicators.push({
              stationId, lineId: line.id, direction, kind, lane,
              instanceIndex: this.turnoutIndicators.length,
              matrix: this.matrix(x, y + 0.75, z, 2.2, 0.25, 0.25, -p.heading),
            });
          }
        }
      }
      if (this.hasCrossover(line.id, i)) {
        for (const direction of [-1, 1] as const) {
          const neighbor = i + direction; if (neighbor < 0 || neighbor >= line.stationIds.length) continue;
          const d = (smooth.stationDistances[i] ?? 0) + direction * (this.crossoverStartOffset(stationId) - 7);
          const p = this.sampleSmooth(smooth, THREE.MathUtils.clamp(d, 0, smooth.length)); if (!p) continue;
          const normalLane = rightHandLane(direction);
          for (const kind of ['crossover-normal', 'crossover-reverse'] as const) {
            const lane: TrackLane = kind === 'crossover-normal' ? normalLane : (-normalLane) as TrackLane;
            const off = MAIN_OFFSET * lane;
            const x = p.x - Math.sin(p.heading) * off;
            const z = p.z + Math.cos(p.heading) * off;
            this.turnoutIndicators.push({
              stationId, lineId: line.id, direction, kind, lane,
              instanceIndex: this.turnoutIndicators.length,
              matrix: this.matrix(x, y + 1.05, z, 3.0, 0.30, 0.30, -p.heading),
            });
          }
        }
      }
    }
  }
  if (!this.turnoutIndicators.length) return;
  this.turnoutMesh = new THREE.InstancedMesh(
    box,
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    this.turnoutIndicators.length,
  );
  for (const indicator of this.turnoutIndicators) {
    this.turnoutMesh.setMatrixAt(indicator.instanceIndex, indicator.matrix);
    this.turnoutMesh.setColorAt(indicator.instanceIndex, new THREE.Color(0xd6a83a));
  }
  this.turnoutMesh.instanceMatrix.needsUpdate = true;
  if (this.turnoutMesh.instanceColor) this.turnoutMesh.instanceColor.needsUpdate = true;
  this.turnoutMesh.frustumCulled = false;
  this.scene.add(this.turnoutMesh);
};
