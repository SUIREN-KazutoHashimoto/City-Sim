import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type AnySmooth = Record<string, any>;

const TERMINAL_PLATFORM_COUNT = 4;
const TERMINAL_FAN_LENGTH = 150;
const TERMINAL_FULL_OFFSET_AT = 52;
const TERMINAL_TRACK_OFFSETS = [-9.5, -1.9, 1.9, 9.5] as const;
const BRAKE = 1.24;
const CROSSOVER_SPEED = 8.4;
const TURNOUT_SPEED = 11.1;
const SIDING_SPEED = 15.0;
const CAR_CLEARANCE = 12;

const proto = RailRenderer.prototype as unknown as AnyRail;
const originalTrackSpeedLimit = proto.trackSpeedLimit as (run: AnyRun, smooth: AnySmooth, distance: number) => number;
const originalTrainTrackOffset = proto.trainTrackOffset as (run: AnyRun, smooth: AnySmooth, distance: number) => number;
const originalPlatformKey = proto.platformKey as (run: AnyRun, stationIndex: number, lane: number) => string;
const originalRouteKeysForPlan = proto.routeKeysForPlan as (run: AnyRun, fromIndex: number, toIndex: number, lane: number) => string[];
const originalBuildTrackGeometry = proto.buildTrackGeometry as () => void;

function smoothStep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function terminalPlatformSlot(self: AnyRail, run: AnyRun, stationIndex: number): number {
  const line = self.rail.lines[run.lineId];
  const stationId = line?.stationIds[stationIndex] ?? 0;
  const raw = run.id * 3 + stationId * 5 + run.depotTrack;
  return ((raw % TERMINAL_PLATFORM_COUNT) + TERMINAL_PLATFORM_COUNT) % TERMINAL_PLATFORM_COUNT;
}

function terminalIndexNear(self: AnyRail, run: AnyRun, smooth: AnySmooth, distance: number): number {
  const line = self.rail.lines[run.lineId];
  if (!line || line.stationIds.length < 2) return -1;
  const last = line.stationIds.length - 1;
  const startStation = self.rail.stations[line.stationIds[0]];
  const endStation = self.rail.stations[line.stationIds[last]];
  const startNear = distance <= TERMINAL_FAN_LENGTH && startStation?.kind === RailStationKind.Terminal;
  const endNear = smooth.length - distance <= TERMINAL_FAN_LENGTH && endStation?.kind === RailStationKind.Terminal;
  if (startNear && endNear) return distance <= smooth.length * 0.5 ? 0 : last;
  if (startNear) return 0;
  if (endNear) return last;
  return -1;
}

function terminalBlend(smooth: AnySmooth, distance: number, stationIndex: number): number {
  const near = stationIndex === 0 ? distance : smooth.length - distance;
  return smoothStep((TERMINAL_FAN_LENGTH - near) / Math.max(1, TERMINAL_FAN_LENGTH - TERMINAL_FULL_OFFSET_AT));
}

function rawGeometryLimit(self: AnyRail, run: AnyRun, smooth: AnySmooth, distance: number): number {
  let limit = self.curveSpeedLimit(smooth, distance) as number;

  if (run.laneChangeStationIndex >= 0 && run.previousLane !== run.lane) {
    const stationId = smooth.line.stationIds[run.laneChangeStationIndex];
    const stationD = smooth.stationDistances[run.laneChangeStationIndex] ?? run.distance;
    const along = (distance - stationD) * run.direction;
    const start = self.crossoverStartOffset(stationId) as number;
    const end = start + 46 + self.consistLength(run) * 0.5;
    if (along >= start - 3 && along <= end) limit = Math.min(limit, CROSSOVER_SPEED);
  }

  if (run.service === 'local' && smooth.line.kind === 'trunk') {
    for (let i = 1; i < smooth.stationDistances.length - 1; i++) {
      if (!self.lineStationHasPassingLoop(run.lineId, i)) continue;
      const half = (self.platformLength(smooth.line.stationIds[i]) as number) * 0.5;
      const profile = self.sidingProfile(Math.abs(distance - smooth.stationDistances[i]), half) as number;
      if (profile > 0.04 && profile < 0.96) limit = Math.min(limit, TURNOUT_SPEED);
      else if (profile >= 0.96) limit = Math.min(limit, SIDING_SPEED);
    }
  }

  const terminalIndex = terminalIndexNear(self, run, smooth, distance);
  if (terminalIndex >= 0) {
    const blend = terminalBlend(smooth, distance, terminalIndex);
    if (blend > 0.04 && blend < 0.98) limit = Math.min(limit, TURNOUT_SPEED);
    else if (blend >= 0.98) limit = Math.min(limit, SIDING_SPEED);
  }
  return limit;
}

proto.trackSpeedLimit = function patchedTrackSpeedLimit(this: AnyRail, run: AnyRun, smooth: AnySmooth, distance: number): number {
  let limit = Math.min(originalTrackSpeedLimit.call(this, run, smooth, distance), rawGeometryLimit(this, run, smooth, distance));
  const brakingDistance = run.speed * run.speed / (2 * BRAKE);
  const horizon = Math.min(420, Math.max(180, brakingDistance + 90));
  for (let ahead = 10; ahead <= horizon; ahead += 10) {
    const sampleDistance = distance + run.direction * ahead;
    if (sampleDistance < 0 || sampleDistance > smooth.length) break;
    const futureLimit = rawGeometryLimit(this, run, smooth, sampleDistance);
    if (futureLimit >= limit - 0.05) continue;
    const usable = Math.max(0, ahead - CAR_CLEARANCE);
    const allowableNow = Math.sqrt(Math.max(0, futureLimit * futureLimit + 2 * BRAKE * usable));
    limit = Math.min(limit, allowableNow);
  }
  return limit;
};

proto.trainTrackOffset = function patchedTrainTrackOffset(this: AnyRail, run: AnyRun, smooth: AnySmooth, distance: number): number {
  const base = originalTrainTrackOffset.call(this, run, smooth, distance);
  const stationIndex = terminalIndexNear(this, run, smooth, distance);
  if (stationIndex < 0) return base;
  const blend = terminalBlend(smooth, distance, stationIndex);
  const slot = terminalPlatformSlot(this, run, stationIndex);
  return THREE.MathUtils.lerp(base, TERMINAL_TRACK_OFFSETS[slot], blend);
};

proto.platformKey = function patchedPlatformKey(this: AnyRail, run: AnyRun, stationIndex: number, lane: number): string {
  const line = this.rail.lines[run.lineId];
  const stationId = line?.stationIds[stationIndex] ?? -1;
  const station = stationId >= 0 ? this.rail.stations[stationId] : null;
  if (line && station?.kind === RailStationKind.Terminal && (stationIndex === 0 || stationIndex === line.stationIds.length - 1)) {
    return `platform:${stationId}:terminal:${line.id}:P${terminalPlatformSlot(this, run, stationIndex)}`;
  }
  return originalPlatformKey.call(this, run, stationIndex, lane);
};

proto.routeKeysForPlan = function patchedRouteKeysForPlan(this: AnyRail, run: AnyRun, fromIndex: number, toIndex: number, lane: number): string[] {
  const keys = originalRouteKeysForPlan.call(this, run, fromIndex, toIndex, lane);
  const line = this.rail.lines[run.lineId];
  const stationId = line?.stationIds[toIndex] ?? -1;
  const station = stationId >= 0 ? this.rail.stations[stationId] : null;
  if (!line || station?.kind !== RailStationKind.Terminal) return keys;
  const slot = terminalPlatformSlot(this, run, toIndex);
  return [...new Set(keys.map((key) => key.startsWith(`terminal:${stationId}:${line.id}:`)
    ? `terminal:${stationId}:${line.id}:P${slot}` : key))];
};

function pointAtOffset(self: AnyRail, smooth: AnySmooth, distance: number, offset: number): { x: number; z: number; heading: number } | null {
  const p = self.sampleSmooth(smooth, distance); if (!p) return null;
  return { x: p.x - Math.sin(p.heading) * offset, z: p.z + Math.cos(p.heading) * offset, heading: p.heading };
}

function buildTerminalFans(self: AnyRail): void {
  const ballast: { matrix: THREE.Matrix4 }[] = [], rails: { matrix: THREE.Matrix4 }[] = [];
  for (const line of self.rail.lines) {
    const smooth = self.smoothLines.get(line.id); if (!smooth || smooth.length < 40) continue;
    const y = self.lineTrackY(line.id) as number;
    for (const terminalIndex of [0, line.stationIds.length - 1]) {
      const stationId = line.stationIds[terminalIndex];
      if (self.rail.stations[stationId]?.kind !== RailStationKind.Terminal) continue;
      const endDistance = terminalIndex === 0 ? 0 : smooth.length;
      const inwardSign = terminalIndex === 0 ? 1 : -1;
      const startDistance = THREE.MathUtils.clamp(endDistance + inwardSign * TERMINAL_FAN_LENGTH, 0, smooth.length);
      const baseLanes = line.kind === 'trunk' ? [-1, 1] : [0];
      for (let slot = 0; slot < TERMINAL_TRACK_OFFSETS.length; slot++) {
        const targetOffset = TERMINAL_TRACK_OFFSETS[slot];
        for (const baseLane of baseLanes) {
          const baseOffset = line.kind === 'trunk' ? 1.72 * baseLane : 0;
          let prev: { x: number; z: number } | null = null;
          const steps = 24;
          for (let n = 0; n <= steps; n++) {
            const t = n / steps;
            const distance = THREE.MathUtils.lerp(startDistance, endDistance, t);
            const blend = smoothStep((TERMINAL_FAN_LENGTH - Math.abs(distance - endDistance)) / Math.max(1, TERMINAL_FAN_LENGTH - TERMINAL_FULL_OFFSET_AT));
            const off = THREE.MathUtils.lerp(baseOffset, targetOffset, blend);
            const q = pointAtOffset(self, smooth, distance, off); if (!q) continue;
            if (prev) self.pushTrackSegment(prev, q, y, ballast, rails, 2.9);
            prev = q;
          }
        }
      }
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
}

proto.buildTrackGeometry = function patchedBuildTrackGeometry(this: AnyRail): void {
  originalBuildTrackGeometry.call(this);
  buildTerminalFans(this);
};

proto.buildDepots = function patchedBuildDepots(this: AnyRail): void {
  const ballast: { matrix: THREE.Matrix4 }[] = [], rails: { matrix: THREE.Matrix4 }[] = [];
  const sheds: { matrix: THREE.Matrix4 }[] = [], apron: { matrix: THREE.Matrix4 }[] = [];
  for (const line of this.rail.lines) {
    const smooth = this.smoothLines.get(line.id); if (!smooth || smooth.path.length < 2) continue;
    const y = this.lineTrackY(line.id) as number;
    for (const end of [0, 1] as const) {
      const baseD = end === 0 ? 0 : smooth.length;
      const base = this.sampleSmooth(smooth, baseD); if (!base) continue;
      const outward = end === 0 ? -1 : 1;
      const sideSign = ((line.id + end) & 1) === 0 ? 1 : -1;
      const makePoint = (along: number, lateral: number): { x: number; z: number } => ({
        x: base.x + Math.cos(base.heading) * outward * along - Math.sin(base.heading) * lateral,
        z: base.z + Math.sin(base.heading) * outward * along + Math.cos(base.heading) * lateral,
      });

      const throat = makePoint(28, sideSign * 3.0);
      const ladder = makePoint(62, sideSign * 9.0);
      selfPush(this, { x: base.x, z: base.z }, throat, y, ballast, rails, 3.0);
      selfPush(this, throat, ladder, y, ballast, rails, 3.0);

      for (let track = 0; track < 4; track++) {
        const off = sideSign * (13.0 + track * 4.4);
        const branch = makePoint(88, off);
        const endPoint = makePoint(420, off);
        selfPush(this, ladder, branch, y, ballast, rails, 2.8);
        selfPush(this, branch, endPoint, y, ballast, rails, 3.2);
      }

      const shedOff = sideSign * (13.0 + 3.5 * 4.4);
      const shed = makePoint(245, shedOff);
      sheds.push({ matrix: this.matrix(shed.x, y + 2.6, shed.z, 118, 5.2, 9.0, -base.heading) });
      const yard = makePoint(230, sideSign * 21);
      apron.push({ matrix: this.matrix(yard.x, y - 0.20, yard.z, 365, 0.18, 42, -base.heading) });
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x66717a, roughness: 0.72, metalness: 0.18 }), sheds);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x555b60, roughness: 0.96 }), apron);
};

function selfPush(self: AnyRail, a: { x: number; z: number }, b: { x: number; z: number }, y: number,
  ballast: { matrix: THREE.Matrix4 }[], rails: { matrix: THREE.Matrix4 }[], width: number): void {
  self.pushTrackSegment(a, b, y, ballast, rails, width);
}

proto.depotBasePose = function patchedDepotBasePose(this: AnyRail, run: AnyRun, smooth: AnySmooth): { x: number; z: number; heading: number } | null {
  const base = this.sampleSmooth(smooth, run.depotEnd === 0 ? 0 : smooth.length); if (!base) return null;
  const outward = run.depotEnd === 0 ? -1 : 1;
  const heading = this.wrapAngle(base.heading + (outward < 0 ? Math.PI : 0));
  const sideSign = ((run.lineId + run.depotEnd) & 1) === 0 ? 1 : -1;
  const off = sideSign * (13.0 + run.depotTrack * 4.4);
  const along = 126 + run.depotSlot * 64;
  return {
    x: base.x + Math.cos(base.heading) * outward * along - Math.sin(base.heading) * off,
    z: base.z + Math.sin(base.heading) * outward * along + Math.cos(base.heading) * off,
    heading,
  };
};

proto.tryReleaseDepotTrain = function patchedTryReleaseDepotTrain(this: AnyRail, run: AnyRun): void {
  const line = this.rail.lines[run.lineId], smooth = this.smoothLines.get(run.lineId); if (!line || !smooth) return;
  const lastRelease = this.lastDepotReleaseAt.get(run.lineId) ?? -Infinity;
  if (this.railTime - lastRelease < 36) return;
  const stationIndex = run.depotEnd === 0 ? 0 : line.stationIds.length - 1;
  const slot = terminalPlatformSlot(this, run, stationIndex);
  const occupied = this.trainRuns.some((other: AnyRun) => other.id !== run.id && other.state !== 'depot'
    && other.lineId === run.lineId && other.currentStationIndex === stationIndex
    && terminalPlatformSlot(this, other, stationIndex) === slot);
  if (occupied) return;
  run.direction = run.depotEnd === 0 ? 1 : -1;
  run.lane = line.kind === 'trunk' ? run.direction : 0;
  run.previousLane = run.lane; run.laneChangeStationIndex = -1;
  run.currentStationIndex = stationIndex; run.originStationIndex = -1; run.nextStationIndex = -1;
  run.distance = this.stationDistanceForRun(run, smooth, stationIndex);
  run.speed = 0; run.currentSpeedLimit = run.cruiseSpeed; run.state = 'dwell'; run.dwellRemaining = 6;
  run.retireAtTerminal = false; run.waitingSince = -1; run.arrivalDelaySeconds = 0; run.scheduledArrivalAt = 0;
  run.scheduledDepartureAt = this.timetable.nextTerminalDeparture(this.railTime + 6, run.lineId, run.direction, run.service, run.trainOrdinal);
  this.lastDepotReleaseAt.set(run.lineId, this.railTime);
};

proto.buildRailSignals = function patchedBuildRailSignals(this: AnyRail): void {
  const poles: { matrix: THREE.Matrix4 }[] = [], heads: { matrix: THREE.Matrix4 }[] = [];
  this.railSignals.length = 0;
  for (const block of this.blocks) {
    const line = this.rail.lines[block.lineId]; if (!line) continue;
    const normalDirection: 1 | -1 = line.kind === 'trunk' ? (block.lane > 0 ? 1 : -1) : 1;
    const directions: (1 | -1)[] = line.kind === 'trunk' ? [normalDirection] : [1, -1];
    for (const direction of directions) {
      const d = direction > 0 ? block.startD : block.endD;
      const smooth = this.smoothLines.get(block.lineId), p = smooth ? this.sampleSmooth(smooth, d) : null; if (!smooth || !p) continue;
      const off = this.trackOffsetAt(smooth, block.lane, d), side = direction > 0 ? -2.35 : 2.35;
      const x = p.x - Math.sin(p.heading) * (off + side), z = p.z + Math.cos(p.heading) * (off + side), y = this.lineTrackY(block.lineId);
      poles.push({ matrix: this.matrix(x, y + 1.65, z, 0.18, 3.3, 0.18) });
      heads.push({ matrix: this.matrix(x, y + 3.45, z, 0.82, 2.08, 0.68, -p.heading + Math.PI / 2) });
      const nextBlockId = this.nextBlockAfter(block.id, direction);
      this.railSignals.push({ lineId: block.lineId, lane: block.lane, direction, blockId: block.id, nextBlockId,
        instanceIndex: this.railSignals.length, x, y, z, heading: p.heading });
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
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; this.scene.add(mesh);
  }
};

proto.setSignalLamp = function patchedSetSignalLamp(this: AnyRail, mesh: THREE.InstancedMesh, signal: AnyRail, lamp: 0 | 1 | 2, on: boolean): void {
  const yy = signal.y + 4.02 - lamp * 0.58, size = on ? 0.30 : 0.105;
  for (let faceIndex = 0; faceIndex < 2; faceIndex++) {
    const sign = faceIndex === 0 ? -signal.direction : signal.direction;
    const face = sign * 0.34;
    const x = signal.x + Math.cos(signal.heading) * face;
    const z = signal.z + Math.sin(signal.heading) * face;
    mesh.setMatrixAt(signal.instanceIndex * 2 + faceIndex, this.matrix(x, yy, z, size, size, size));
  }
};
