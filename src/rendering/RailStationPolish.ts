import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };
type BoardDirection = -1 | 0 | 1;

type DepartureBoard = {
  stationId: number;
  lineId: number;
  stationIndex: number;
  direction: BoardDirection;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  signature: string;
};

type Departure = {
  at: number;
  service: string;
  destination: string;
  trainId: number;
};

const proto = RailRenderer.prototype as unknown as Record<string, any>;
const baseBrake = Number((RailRenderer as unknown as Record<string, any>).BRAKE ?? 1.24);
const stationBrake = Math.max(baseBrake, 1.68);
const originalBuildPlatformRibbon = proto.buildPlatformRibbon as (...args: any[]) => void;
const previousBuildStations = proto.buildStations as () => void;
const previousUpdate = proto.update as (realDt?: number, timeScale?: number, paused?: boolean) => void;
const previousStepTrain = proto.stepTrain as (run: AnyRun, dt: number) => void;

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRAIN_HALF_WIDTH = 2.86 * 0.5;
const PLATFORM_CLEARANCE = 0.48;
const BOARD_UPDATE_SECONDS = 30;
const BOARD_Y = 3.72;
const BOARD_FACE_OFFSET = 0.081;

function platformWidth(kind: RailStationKind): number {
  return kind === RailStationKind.Central || kind === RailStationKind.SubCenter ? 4.2 : 3.8;
}

function boardPlatforms(self: AnyRail, line: AnyRun, smooth: AnySmooth, stationIndex: number): Array<{ offset: number; direction: BoardDirection }> {
  const stationId = line.stationIds[stationIndex];
  const station = self.rail.stations[stationId];
  if (!station) return [];
  const width = platformWidth(station.kind as RailStationKind);

  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(line.id, stationIndex)) {
    const island = (MAIN_OFFSET + SIDING_OFFSET) * 0.5;
    return [
      { offset: -island, direction: 1 },
      { offset: island, direction: -1 },
    ];
  }
  if (line.kind === 'trunk') {
    const outer = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
    return [
      { offset: -outer, direction: 1 },
      { offset: outer, direction: -1 },
    ];
  }

  const center = smooth.stationDistances[stationIndex] ?? 0;
  const track = self.sharedSpurOffset(smooth, center) as number;
  const side = track >= 0 ? 1 : -1;
  return [{ offset: track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5), direction: 0 }];
}

/** 旧RailRendererの低い簡易屋根だけ破棄し、新しい駅外装の屋根へ一本化する。 */
proto.buildPlatformRibbon = function stationRibbonWithoutLegacyRoof(
  this: AnyRail,
  smooth: AnySmooth,
  center: number,
  length: number,
  offset: number,
  width: number,
  includeSign: boolean,
  y: number,
  platforms: StaticPart[],
  _legacyRoofs: StaticPart[],
  signs: StaticPart[],
  columns: StaticPart[],
  stairs: StaticPart[],
): void {
  const discardedRoofs: StaticPart[] = [];
  originalBuildPlatformRibbon.call(
    this,
    smooth,
    center,
    length,
    offset,
    width,
    includeSign,
    y,
    platforms,
    discardedRoofs,
    signs,
    columns,
    stairs,
  );
};

function effectiveDirection(self: AnyRail, run: AnyRun): 1 | -1 {
  const line = self.rail.lines[run.lineId];
  if (!line) return run.direction > 0 ? 1 : -1;
  const last = line.stationIds.length - 1;
  if (run.currentStationIndex === 0 && run.direction < 0) return 1;
  if (run.currentStationIndex === last && run.direction > 0) return -1;
  return run.direction > 0 ? 1 : -1;
}

function estimatedArrivalAtNextStation(self: AnyRail, run: AnyRun): number {
  if (run.scheduledArrivalAt > self.railTime - 1) return Math.max(self.railTime, run.scheduledArrivalAt);
  const smooth = self.smoothLines.get(run.lineId) as AnySmooth | undefined;
  if (!smooth || run.nextStationIndex < 0) return self.railTime;
  const target = self.stationDistanceForRun(run, smooth, run.nextStationIndex) as number;
  const remaining = Math.abs(target - run.distance);
  const speed = Math.max(5.5, Math.min(run.cruiseSpeed, Math.max(run.speed, 8.0)));
  return self.railTime + remaining / speed;
}

function isNonRevenueRun(self: AnyRail, run: AnyRun): boolean {
  if (run.state === 'depot') return true;
  if (run.retireAtTerminal && run.currentStationIndex >= 0) return true;
  if (typeof self.actualStateLabel === 'function') {
    const label = String(self.actualStateLabel(run) ?? '');
    if (label === '回送' || label.includes('入庫')) return true;
  }
  return false;
}

function projectedDeparture(self: AnyRail, run: AnyRun, stationIndex: number, boardDirection: BoardDirection): Departure | null {
  if (isNonRevenueRun(self, run)) return null;
  const line = self.rail.lines[run.lineId];
  if (!line || stationIndex < 0 || stationIndex >= line.stationIds.length) return null;
  const direction = effectiveDirection(self, run);
  if (boardDirection !== 0 && direction !== boardDirection) return null;
  const last = line.stationIds.length - 1;
  const destinationId = line.stationIds[direction > 0 ? last : 0];
  const destination = self.rail.stations[destinationId]?.name ?? '終点';

  if (run.currentStationIndex === stationIndex) {
    const at = Math.max(self.railTime, run.scheduledDepartureAt || self.railTime);
    return { at, service: self.serviceLabel(run.service), destination, trainId: run.id };
  }

  let index: number;
  let arrival: number;
  if (run.currentStationIndex >= 0) {
    const next = run.currentStationIndex + direction;
    if (next < 0 || next > last) return null;
    index = next;
    const departure = Math.max(self.railTime, run.scheduledDepartureAt || self.railTime);
    arrival = departure + (self.nominalTravelSeconds(run, run.currentStationIndex, next) as number);
  } else if (run.nextStationIndex >= 0) {
    index = run.nextStationIndex;
    arrival = estimatedArrivalAtNextStation(self, run);
  } else {
    return null;
  }

  for (let guard = 0; guard <= line.stationIds.length; guard++) {
    if (index < 0 || index > last) return null;
    const stationId = line.stationIds[index];
    const stops = index === 0 || index === last || self.shouldStop(run, index);
    const dwell = stops ? Number(self.dwellSeconds(run, stationId) ?? 0) : 0;
    const departure = arrival + dwell;
    if (index === stationIndex) {
      if (!stops) return null;
      return { at: departure, service: self.serviceLabel(run.service), destination, trainId: run.id };
    }
    const next = index + direction;
    if (next < 0 || next > last) return null;
    arrival = departure + (self.nominalTravelSeconds(run, index, next) as number);
    index = next;
  }
  return null;
}

function departuresForBoard(self: AnyRail, board: DepartureBoard): Departure[] {
  const byTrain = new Map<number, Departure>();
  for (const run of self.trainRuns as AnyRun[]) {
    if (run.lineId !== board.lineId) continue;
    const departure = projectedDeparture(self, run, board.stationIndex, board.direction);
    if (!departure || departure.at < self.railTime - 5 || departure.at > self.railTime + 4 * 3600) continue;
    const current = byTrain.get(departure.trainId);
    if (!current || departure.at < current.at) byTrain.set(departure.trainId, departure);
  }
  return [...byTrain.values()].sort((a, b) => a.at - b.at || a.trainId - b.trainId).slice(0, 3);
}

function formatTime(seconds: number): string {
  const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function drawBoard(self: AnyRail, board: DepartureBoard): void {
  const departures = departuresForBoard(self, board);
  const lineName = self.rail.lines[board.lineId]?.name ?? `L${board.lineId}`;
  const stationName = self.rail.stations[board.stationId]?.name ?? '駅';
  const signature = `${Math.floor(self.railTime / 30)}|${departures.map((d) => `${Math.floor(d.at / 60)}:${d.service}:${d.destination}`).join('|')}`;
  if (signature === board.signature) return;
  board.signature = signature;

  const ctx = board.context;
  const w = board.canvas.width;
  const h = board.canvas.height;
  ctx.fillStyle = '#07100e';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c7ded5';
  ctx.font = '600 16px sans-serif';
  ctx.fillText(fitText(ctx, `${stationName}  ${lineName}`, w - 18), 10, 19);
  ctx.fillStyle = '#47635b';
  ctx.fillRect(8, 26, w - 16, 1);

  if (!departures.length) {
    ctx.fillStyle = '#7f918b';
    ctx.font = '600 17px sans-serif';
    ctx.fillText('発車予定なし', 12, 72);
  } else {
    departures.forEach((departure, row) => {
      const y = 51 + row * 29;
      ctx.fillStyle = '#ffb84d';
      ctx.font = '700 20px ui-monospace, monospace';
      ctx.fillText(formatTime(departure.at), 10, y);
      ctx.fillStyle = departure.service === '特急' ? '#ff756d' : departure.service === '快速' ? '#ffb84d' : '#7ff0a4';
      ctx.font = '700 15px sans-serif';
      ctx.fillText(departure.service, 92, y);
      ctx.fillStyle = '#eef5f2';
      ctx.font = '600 15px sans-serif';
      ctx.fillText(fitText(ctx, `${departure.destination} 行`, w - 154), 143, y);
    });
  }
  board.texture.needsUpdate = true;
}

function buildDepartureBoards(self: AnyRail): void {
  const boards: DepartureBoard[] = [];
  const backs: StaticPart[] = [];
  const hangers: StaticPart[] = [];
  const boardGeometry = new THREE.PlaneGeometry(3.62, 1.18);

  for (const line of self.rail.lines as AnyRun[]) {
    const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
    if (!smooth) continue;
    const y = self.lineTrackY(line.id) as number;
    for (let stationIndex = 0; stationIndex < line.stationIds.length; stationIndex++) {
      const stationId = line.stationIds[stationIndex];
      const center = smooth.stationDistances[stationIndex] ?? 0;
      const length = self.platformLength(stationId) as number;
      const boardDistance = THREE.MathUtils.clamp(center + Math.min(16, length * 0.18), 0, smooth.length as number);

      for (const platform of boardPlatforms(self, line, smooth, stationIndex)) {
        const p = self.offsetPoint(smooth, boardDistance, platform.offset) as { x: number; z: number; heading: number } | null;
        if (!p) continue;
        const boardY = y + BOARD_Y;
        const rotation = -p.heading + Math.PI / 2;
        backs.push({ matrix: self.matrix(p.x, boardY, p.z, 3.85, 1.38, 0.15, rotation) });

        const lateralX = Math.cos(p.heading + Math.PI / 2);
        const lateralZ = Math.sin(p.heading + Math.PI / 2);
        for (const side of [-1, 1]) {
          hangers.push({
            matrix: self.matrix(
              p.x + lateralX * 1.38 * side,
              y + 4.43,
              p.z + lateralZ * 1.38 * side,
              0.10,
              0.42,
              0.10,
            ),
          });
        }

        const canvas = document.createElement('canvas');
        canvas.width = 384;
        canvas.height = 144;
        const context = canvas.getContext('2d');
        if (!context) continue;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide, toneMapped: false });
        const normalX = Math.sin(rotation);
        const normalZ = Math.cos(rotation);
        for (const face of [-1, 1]) {
          const mesh = new THREE.Mesh(boardGeometry, material);
          mesh.position.set(
            p.x + normalX * BOARD_FACE_OFFSET * face,
            boardY,
            p.z + normalZ * BOARD_FACE_OFFSET * face,
          );
          mesh.rotation.y = rotation + (face < 0 ? Math.PI : 0);
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          self.scene.add(mesh);
        }
        boards.push({ stationId, lineId: line.id, stationIndex, direction: platform.direction, canvas, context, texture, signature: '' });
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x171d1c, roughness: 0.55, metalness: 0.18 }), backs);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x636b69, roughness: 0.66, metalness: 0.34 }), hangers);
  self.departureBoards = boards;
  self.lastDepartureBoardUpdate = -Infinity;
  for (const board of boards) drawBoard(self, board);
}

proto.buildStations = function stationBuildWithDepartureBoards(this: AnyRail): void {
  previousBuildStations.call(this);
  buildDepartureBoards(this);
};

function updateDepartureBoards(self: AnyRail): void {
  const boards = self.departureBoards as DepartureBoard[] | undefined;
  if (!boards?.length) return;
  if (self.railTime - Number(self.lastDepartureBoardUpdate ?? -Infinity) < BOARD_UPDATE_SECONDS) return;
  self.lastDepartureBoardUpdate = self.railTime;
  for (const board of boards) drawBoard(self, board);
}

/**
 * 通常駅停車時だけ常用ブレーキを強め、低速で長時間這う進入を減らす。
 * 赤信号が見えている場合は従来の制動力を維持し、閉塞安全側の停止距離を変えない。
 */
proto.stepTrain = function decisiveStationApproach(this: AnyRail, run: AnyRun, dt: number): void {
  let useStationBrake = false;
  if (run.state === 'running' && run.nextStationIndex >= 0) {
    const smooth = this.smoothLines.get(run.lineId) as AnySmooth | undefined;
    if (smooth) {
      const stopIndex = this.shouldStop(run, run.nextStationIndex)
        ? run.nextStationIndex
        : this.nextScheduledStopIndex(run, run.nextStationIndex);
      if (stopIndex >= 0) {
        const stopDistance = this.stationDistanceForRun(run, smooth, stopIndex) as number;
        const remaining = Math.abs(stopDistance - run.distance);
        const control = this.sectionControl(run) as { redDistance: number };
        useStationBrake = remaining <= 520 && !Number.isFinite(control.redDistance);
      }
    }
  }

  const railClass = RailRenderer as unknown as Record<string, any>;
  const previousBrake = railClass.BRAKE;
  railClass.BRAKE = useStationBrake ? stationBrake : baseBrake;
  try {
    previousStepTrain.call(this, run, dt);
  } finally {
    railClass.BRAKE = previousBrake;
  }
};

proto.update = function stationPolishUpdate(this: AnyRail, realDt = 1 / 60, timeScale = 1, paused = false): void {
  previousUpdate.call(this, realDt, timeScale, paused);
  updateDepartureBoards(this);
};
