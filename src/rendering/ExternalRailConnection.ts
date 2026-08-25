import * as THREE from 'three';
import type { RailRenderer } from './RailRenderer';
import { installExternalRailConnection as installStraightExternalRailConnection } from './StraightRoadExternalRailConnection';
import { latestHighSpeedRailInspectionSource, type HighSpeedTrainStatusSnapshot } from './HighSpeedRailRegistry';

type Direction = 1 | -1;
type HighSpeedState = 'running' | 'dwell';

interface HighSpeedTrainRuntime {
  id: number;
  direction: Direction;
  carCount: number;
  position: number;
  speed: number;
  state: HighSpeedState;
  stoppedAtCentral: boolean;
  dwellUntil: number;
  exchanged: boolean;
  passengers?: number;
  passengerCapacity?: number;
}

interface HighSpeedRouteRuntime {
  centralPosition: number;
  length: number;
  heading: number;
  trackY: number;
  roadAxis: 0 | 1;
  minRoadWidth: number;
}

interface VisitorStatsRuntime {
  active: number;
  shopping: number;
  tourism: number;
  hotelGuests: number;
  waitingOutbound: number;
}

interface MutableHighSpeedPointSource {
  __citySimLeftHandTrackV022?: boolean;
  __citySimServiceV024?: boolean;
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
  trains?: HighSpeedTrainRuntime[];
  route?: HighSpeedRouteRuntime;
  central?: { id: number };
  visitorSystem?: {
    exchangeAtStation: (stationId: number, capacity: number, now: number, seed: number) => { arrived: number; boarded: number };
    advanceTo?: (now: number) => void;
    stats?: () => VisitorStatsRuntime;
  } | null;
  consistLength?: (carCount: number) => number;
  spawn?: (direction: Direction, now: number) => void;
  stepTrain?: (train: HighSpeedTrainRuntime, dt: number, now: number) => boolean;
  advanceInterval?: (dt: number, startTime: number) => void;
  advanceTo?: (now: number) => void;
  syncMeshes?: () => void;
  updatePanel?: (force: boolean) => void;
  trainStatus?: (id: number) => HighSpeedTrainStatusSnapshot | null;
  carBody?: THREE.InstancedMesh;
  carWindow?: THREE.InstancedMesh;
  carStripe?: THREE.InstancedMesh;
  instanceTrainIds?: Int32Array;
  nextDown?: number;
  nextUp?: number;
  lastTime?: number;
  lastPanelAt?: number;
  panel?: HTMLDivElement | null;
}

interface HighSpeedInspectionAdapterInternal {
  source?: MutableHighSpeedPointSource;
}

interface CarLayout {
  bodyCenter: number;
  bodyLength: number;
}

const HSR_MAX_SPEED_MPS = 320 / 3.6;
const HSR_ACCEL_MPS2 = 1.71 / 3.6;
const HSR_BRAKE_MPS2 = 2.7 / 3.6;
const HSR_DWELL_SECONDS = 12 * 60;
const HSR_HEADWAY_SECONDS = 15 * 60;
const HSR_UP_PHASE_SECONDS = HSR_HEADWAY_SECONDS * 0.5;
const HSR_PASSENGERS_PER_CAR = 90;
const HSR_TRACK_OFFSET = 2.4;
const HSR_MIDDLE_CAR_LENGTH = 25.0;
const HSR_END_CAR_LENGTH = 24.0;
const HSR_NOSE_LENGTH = 9.0;
const HSR_CAR_GAP = 1.0;
const HSR_WIDTH = 3.4;
const HSR_HEIGHT = 3.7;

function matrixBox(x: number, y: number, z: number, length: number, height: number, width: number, heading: number): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

function hash01(value: number): number {
  let x = (value ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0x100000000;
}

function nextSlot(after: number, phase: number): number {
  return phase + (Math.floor((after - phase) / HSR_HEADWAY_SECONDS) + 1) * HSR_HEADWAY_SECONDS;
}

function formatClock(seconds: number): string {
  const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

function hsrConsistLength(carCount: number): number {
  if (carCount <= 0) return 0;
  if (carCount === 1) return HSR_END_CAR_LENGTH;
  const bodies = HSR_END_CAR_LENGTH * 2 + Math.max(0, carCount - 2) * HSR_MIDDLE_CAR_LENGTH;
  return bodies + Math.max(0, carCount - 1) * HSR_CAR_GAP;
}

function carLayout(carCount: number): CarLayout[] {
  if (carCount <= 0) return [];
  const total = hsrConsistLength(carCount);
  let cursor = -total * 0.5;
  const out: CarLayout[] = [];

  for (let car = 0; car < carCount; car++) {
    const endCar = car === 0 || car === carCount - 1;
    const fullLength = endCar ? HSR_END_CAR_LENGTH : HSR_MIDDLE_CAR_LENGTH;
    if (endCar) {
      const bodyLength = Math.max(1, HSR_END_CAR_LENGTH - HSR_NOSE_LENGTH);
      const noseAtNegativeEnd = car === 0;
      const bodyStart = noseAtNegativeEnd ? cursor + HSR_NOSE_LENGTH : cursor;
      out.push({ bodyCenter: bodyStart + bodyLength * 0.5, bodyLength });
    } else {
      out.push({ bodyCenter: cursor + fullLength * 0.5, bodyLength: fullLength });
    }
    cursor += fullLength + (car < carCount - 1 ? HSR_CAR_GAP : 0);
  }
  return out;
}

function passengerLoadFactor(timeSeconds: number, trainId: number, direction: Direction): number {
  const daySeconds = ((timeSeconds % 86400) + 86400) % 86400;
  const hour = daySeconds / 3600;
  const peak = (hour >= 7 && hour < 9.5) || (hour >= 17 && hour < 19.5);
  const r = hash01(trainId * 92821 + direction * 131 + Math.floor(timeSeconds / 900) * 17);
  if (peak) return 0.90 + r * 0.09;
  if (hour >= 9.5 && hour < 17) return 0.30 + r * 0.38;
  if ((hour >= 6 && hour < 7) || (hour >= 19.5 && hour < 22)) return 0.22 + r * 0.34;
  return 0.10 + r * 0.20;
}

function targetPassengers(train: HighSpeedTrainRuntime, timeSeconds: number): number {
  const capacity = train.passengerCapacity ?? train.carCount * HSR_PASSENGERS_PER_CAR;
  return Math.max(1, Math.min(capacity, Math.round(capacity * passengerLoadFactor(timeSeconds, train.id, train.direction))));
}

function installHighSpeedService(source: MutableHighSpeedPointSource): void {
  if (source.__citySimServiceV024) return;

  const trains = source.trains;
  const route = source.route;
  const central = source.central;
  const pointAt = source.pointAt?.bind(source);
  const baseSpawn = source.spawn?.bind(source);
  const advanceInterval = source.advanceInterval?.bind(source);
  const baseTrainStatus = source.trainStatus?.bind(source);
  if (!trains || !route || !central || !pointAt || !baseSpawn || !advanceInterval || typeof source.stepTrain !== 'function') return;

  source.consistLength = hsrConsistLength;

  source.spawn = (direction, now) => {
    const before = trains.length;
    baseSpawn(direction, now);
    const train = trains[before] ?? trains[trains.length - 1];
    if (!train) return;
    train.passengerCapacity = train.carCount * HSR_PASSENGERS_PER_CAR;
    train.passengers = targetPassengers(train, now);
    const toCentral = Math.abs(route.centralPosition - train.position);
    train.speed = Math.min(
      HSR_MAX_SPEED_MPS,
      Math.sqrt(Math.max(0, 2 * HSR_BRAKE_MPS2 * Math.max(0, toCentral - 20))),
    );
  };

  source.stepTrain = (train, dt, now) => {
    if (train.state === 'dwell') {
      train.speed = 0;
      if (now + 1e-7 < train.dwellUntil) return false;
      train.state = 'running';
      train.stoppedAtCentral = true;
      const desired = targetPassengers(train, now);
      train.passengers = Math.min(train.passengerCapacity ?? desired, Math.max(train.passengers ?? 0, desired));
    }

    if (!train.stoppedAtCentral) {
      const remaining = Math.max(0, (route.centralPosition - train.position) * train.direction);
      const target = Math.min(
        HSR_MAX_SPEED_MPS,
        Math.sqrt(Math.max(0, 2 * HSR_BRAKE_MPS2 * Math.max(0, remaining - 1.5))),
      );
      train.speed = train.speed < target
        ? Math.min(target, train.speed + HSR_ACCEL_MPS2 * dt)
        : Math.max(target, train.speed - HSR_BRAKE_MPS2 * dt);

      const move = train.speed * dt;
      if (move + 0.35 >= remaining) {
        train.position = route.centralPosition;
        train.speed = 0;
        train.state = 'dwell';
        train.dwellUntil = now + HSR_DWELL_SECONDS;
        if (!train.exchanged) {
          const inbound = Math.max(0, train.passengers ?? targetPassengers(train, now));
          const exchange = source.visitorSystem?.exchangeAtStation(
            central.id,
            Math.max(80, inbound),
            now,
            1_000_000 + train.id,
          );
          if (exchange) {
            const through = Math.max(0, inbound - exchange.arrived);
            train.passengers = Math.min(train.passengerCapacity ?? inbound, through + exchange.boarded);
          }
          train.exchanged = true;
        }
        source.updatePanel?.(true);
        return false;
      }
      train.position += train.direction * move;
      return false;
    }

    train.speed = Math.min(HSR_MAX_SPEED_MPS, train.speed + HSR_ACCEL_MPS2 * dt);
    train.position += train.direction * train.speed * dt;
    const half = hsrConsistLength(train.carCount) * 0.5;
    return train.direction > 0 ? train.position - half > route.length : train.position + half < 0;
  };

  if (typeof source.lastTime === 'number') {
    source.nextDown = nextSlot(source.lastTime - 1e-6, 0);
    source.nextUp = nextSlot(source.lastTime - 1e-6, HSR_UP_PHASE_SECONDS);
  }

  source.advanceTo = (now) => {
    if (!Number.isFinite(now) || typeof source.lastTime !== 'number' || now <= source.lastTime + 1e-7) return;
    if (typeof source.nextDown !== 'number') source.nextDown = nextSlot(source.lastTime - 1e-6, 0);
    if (typeof source.nextUp !== 'number') source.nextUp = nextSlot(source.lastTime - 1e-6, HSR_UP_PHASE_SECONDS);

    while (Math.min(source.nextDown, source.nextUp) <= now + 1e-7) {
      const event = Math.min(source.nextDown, source.nextUp);
      advanceInterval(event - source.lastTime, source.lastTime);
      source.lastTime = event;
      if (source.nextDown <= event + 1e-7) {
        source.spawn?.(1, event);
        source.nextDown += HSR_HEADWAY_SECONDS;
      }
      if (source.nextUp <= event + 1e-7) {
        source.spawn?.(-1, event);
        source.nextUp += HSR_HEADWAY_SECONDS;
      }
    }

    advanceInterval(now - source.lastTime, source.lastTime);
    source.lastTime = now;
    source.visitorSystem?.advanceTo?.(now);
    source.updatePanel?.(false);
  };

  if (source.carBody && source.carWindow && source.carStripe && source.instanceTrainIds) {
    source.syncMeshes = () => {
      let bodyCount = 0;
      let panelCount = 0;
      source.instanceTrainIds!.fill(-1);

      for (const train of trains) {
        const trackOffset = train.direction > 0 ? HSR_TRACK_OFFSET : -HSR_TRACK_OFFSET;
        const heading = route.heading + (train.direction > 0 ? 0 : Math.PI);
        const layout = carLayout(train.carCount);
        for (let car = 0; car < layout.length && bodyCount < source.instanceTrainIds!.length; car++) {
          const item = layout[car];
          const along = train.position + item.bodyCenter;
          const center = source.pointAt!(along, trackOffset);
          const y = route.trackY + HSR_HEIGHT * 0.5;
          source.carBody!.setMatrixAt(bodyCount, matrixBox(center.x, y, center.z, item.bodyLength, HSR_HEIGHT, HSR_WIDTH, heading));
          source.instanceTrainIds![bodyCount] = train.id;

          for (const side of [-1, 1]) {
            const panel = source.pointAt!(along, trackOffset + side * (HSR_WIDTH * 0.5 + 0.035));
            source.carWindow!.setMatrixAt(panelCount, matrixBox(panel.x, y + 0.58, panel.z, item.bodyLength * 0.72, 0.76, 0.07, heading));
            source.carStripe!.setMatrixAt(panelCount, matrixBox(panel.x, y - 0.58, panel.z, item.bodyLength * 0.94, 0.24, 0.075, heading));
            panelCount++;
          }
          bodyCount++;
        }
      }

      source.carBody!.count = bodyCount;
      source.carWindow!.count = panelCount;
      source.carStripe!.count = panelCount;
      source.carBody!.instanceMatrix.needsUpdate = true;
      source.carWindow!.instanceMatrix.needsUpdate = true;
      source.carStripe!.instanceMatrix.needsUpdate = true;
    };
  }

  if (baseTrainStatus) {
    source.trainStatus = (id) => {
      const snapshot = baseTrainStatus(id);
      if (!snapshot) return null;
      const train = trains.find((item) => item.id === id);
      if (!train) return snapshot;
      const capacity = train.passengerCapacity ?? train.carCount * HSR_PASSENGERS_PER_CAR;
      const passengers = Math.max(0, Math.min(capacity, train.passengers ?? 0));
      const load = capacity > 0 ? passengers / capacity : 0;
      return {
        ...snapshot,
        consistLength: hsrConsistLength(train.carCount),
        stateLabel: `${snapshot.stateLabel} / 乗客 ${passengers}/${capacity} (${Math.round(load * 100)}%)`,
        firstPersonForwardOffset: hsrConsistLength(train.carCount) * 0.5 + 0.5,
      };
    };
  }

  if (source.panel) {
    source.updatePanel = (force) => {
      const now = source.lastTime ?? 0;
      if (!force && now - (source.lastPanelAt ?? -Infinity) < 30) return;
      source.lastPanelAt = now;
      const visitors = source.visitorSystem?.stats?.();
      const cars = trains.reduce((sum, train) => sum + train.carCount, 0);
      const stopped = trains.filter((train) => train.state === 'dwell').length;
      const passengers = trains.reduce((sum, train) => sum + (train.passengers ?? 0), 0);
      const capacity = trains.reduce((sum, train) => sum + (train.passengerCapacity ?? train.carCount * HSR_PASSENGERS_PER_CAR), 0);
      source.panel!.textContent = `外部高速線 1路線  直線・道路上高架  最高320km/h\n`
        + `中間車25m / 先頭車24m(ノーズ込)  幅3.4m 高さ3.7m\n`
        + `中央駅 12分停車 / 同方向15分間隔 / 発車3分後に次列車\n`
        + `運転中 ${trains.length}編成 (${cars}両)  中央停車${stopped}  乗客${passengers}/${capacity}\n`
        + `次回進入 下り${formatClock(source.nextDown ?? 0)} / 上り${formatClock(source.nextUp ?? 0)}\n`
        + (visitors
          ? `来訪者 ${visitors.active.toLocaleString()}人  買物${visitors.shopping.toLocaleString()} 観光${visitors.tourism.toLocaleString()} 宿泊${visitors.hotelGuests.toLocaleString()}\n帰路待ち ${visitors.waitingOutbound.toLocaleString()}`
          : '来訪者モデル 準備中');
    };
  }

  source.__citySimServiceV024 = true;
  source.syncMeshes?.();
  source.updatePanel?.(true);
}

/** Keep the dedicated HSR on the Japanese left-hand track and apply the v0.1.24 service model. */
export function installExternalRailConnection(renderer: RailRenderer): void {
  installStraightExternalRailConnection(renderer);

  const inspection = latestHighSpeedRailInspectionSource();
  const adapter = inspection as unknown as HighSpeedInspectionAdapterInternal;
  const source = adapter?.source;
  if (!source) return;

  if (!source.__citySimLeftHandTrackV022 && typeof source.pointAt === 'function') {
    const basePointAt = source.pointAt.bind(source);
    source.pointAt = (s: number, offset = 0) => basePointAt(s, -offset);
    source.__citySimLeftHandTrackV022 = true;
  }

  installHighSpeedService(source);
}
