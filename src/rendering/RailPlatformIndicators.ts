import * as THREE from 'three';
import type { RailRenderer } from './RailRenderer';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type TrackLane = -1 | 0 | 1;
type TrackMode = 'main' | 'siding';
type BoardState = '接近' | '停車中' | '発車' | '待機';
type TrainService = 'local' | 'rapid' | 'limited';

interface RailLineLike { id: number; kind: 'trunk' | 'spur'; stationIds: number[]; }
interface StationLike { id?: number; name?: string; }
interface SmoothLineLike { length: number; stationDistances: number[]; }
interface TrainRunLike {
  id: number;
  lineId: number;
  service: TrainService;
  state: 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';
  direction: 1 | -1;
  speed: number;
  cruiseSpeed: number;
  distance: number;
  lane: TrackLane;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  scheduledDepartureAt: number;
  scheduledArrivalAt: number;
  deadhead?: boolean;
}

interface CityRuntime {
  scene: THREE.Scene;
  railTime: number;
  rail: { lines: RailLineLike[]; stations: Array<StationLike | undefined> };
  trainRuns: TrainRunLike[];
  smoothLines: Map<number, SmoothLineLike>;
  updateTrainMeshes: () => void;
  lineTrackY: (lineId: number) => number;
  sampleSmooth: (smooth: SmoothLineLike, distance: number) => { x: number; z: number; heading: number } | null;
  sharedSpurOffset: (smooth: SmoothLineLike, distance: number) => number;
  lineStationHasPassingLoop: (lineId: number, stationIndex: number) => boolean;
  shouldStop: (run: TrainRunLike, stationIndex: number) => boolean;
}

interface BoardVisual {
  group: THREE.Group;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
}

interface BoardDeparture {
  time: number;
  service: TrainService;
  destination: string;
}

interface CityBoard extends BoardVisual {
  stationId: number;
  lineId: number;
  stationIndex: number;
  lane: TrackLane;
  mode: TrackMode;
  trackNo: number;
  lastSignature: string;
}

interface HighSpeedTrainLike {
  direction: 1 | -1;
  position: number;
  state: 'running' | 'dwell';
  stoppedAtCentral: boolean;
}
interface HighSpeedSource {
  trains?: HighSpeedTrainLike[];
  route?: { centralPosition: number; length: number; heading: number; trackY: number };
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
  syncMeshes?: () => void;
  rt?: { scene: THREE.Scene };
}
interface HighSpeedAdapter { source?: HighSpeedSource; }
interface HsrBoard extends BoardVisual {
  direction: 1 | -1;
  trackNo: number;
  lastSignature: string;
}

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 10.0;
const HSR_TRACK_OFFSET = 2.4;
const BOARD_CENTER_HEIGHT = 3.72;
const BOARD_ALONG_SHIFT = 16;
const BOARD_REFRESH_SECONDS = 1;

/** Very small ceiling-hung departure display, mounted perpendicular to the platform axis. */
function boardVisual(scene: THREE.Scene, heading: number): BoardVisual {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  group.rotation.y = -heading + Math.PI / 2;

  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: 0.58, metalness: 0.55 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.40, 0.78, 0.16), frameMaterial);
  frame.castShadow = true;
  group.add(frame);

  const displayMaterial = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(2.22, 0.64), displayMaterial);
  front.position.z = 0.086;
  group.add(front);

  const back = new THREE.Mesh(new THREE.PlaneGeometry(2.22, 0.64), displayMaterial.clone());
  back.rotation.y = Math.PI;
  back.position.z = -0.086;
  group.add(back);

  const hangerMaterial = new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.52, metalness: 0.62 });
  for (const x of [-0.88, 0.88]) {
    const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.26, 0.09), hangerMaterial);
    hanger.position.set(x, 0.52, 0);
    hanger.castShadow = true;
    group.add(hanger);
  }
  const ceilingBar = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.09, 0.12), hangerMaterial.clone());
  ceilingBar.position.set(0, 0.66, 0);
  ceilingBar.castShadow = true;
  group.add(ceilingBar);

  scene.add(group);
  return { group, canvas, texture };
}

function serviceLabel(service: TrainService): string {
  return service === 'limited' ? '特急' : service === 'rapid' ? '快速' : '普通';
}

function serviceColor(service: TrainService): string {
  return service === 'limited' ? '#ff8966' : service === 'rapid' ? '#64c8ff' : '#f1f5f8';
}

function formatBoardTime(seconds: number): string {
  const day = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const h = Math.floor(day / 3600);
  const m = Math.floor((day % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function drawBoard(
  board: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; trackNo: number; lastSignature: string },
  state: BoardState,
  departures: BoardDeparture[] = [],
): void {
  const rows = departures.slice(0, 3);
  const signature = `${state}|${rows.map((row) => `${formatBoardTime(row.time)}:${row.service}:${row.destination}`).join('|')}`;
  if (board.lastSignature === signature) return;
  board.lastSignature = signature;

  const ctx = board.canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#050708';
  ctx.fillRect(0, 0, board.canvas.width, board.canvas.height);
  ctx.strokeStyle = '#596068';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, board.canvas.width - 6, board.canvas.height - 6);

  const stateColor = state === '接近' ? '#ffb020' : state === '停車中' ? '#54f070' : state === '発車' ? '#55c8ff' : '#98a1aa';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f0f4f7';
  ctx.font = '700 22px ui-monospace, sans-serif';
  ctx.fillText(`${board.trackNo}番線`, 16, 24);
  ctx.fillStyle = stateColor;
  ctx.font = '700 20px ui-monospace, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(state, 494, 24);
  ctx.textAlign = 'left';

  ctx.strokeStyle = '#30363c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(12, 43);
  ctx.lineTo(500, 43);
  ctx.stroke();

  const rowHeight = 46;
  for (let i = 0; i < 3; i++) {
    const y = 66 + i * rowHeight;
    if (i > 0) {
      ctx.strokeStyle = '#20262b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(12, y - 23);
      ctx.lineTo(500, y - 23);
      ctx.stroke();
    }
    const row = rows[i];
    if (!row) {
      ctx.fillStyle = '#535b63';
      ctx.font = '600 18px ui-monospace, sans-serif';
      ctx.fillText('--:--', 16, y);
      ctx.fillText('---', 118, y);
      continue;
    }
    ctx.fillStyle = '#ffd65a';
    ctx.font = '700 20px ui-monospace, sans-serif';
    ctx.fillText(formatBoardTime(row.time), 16, y);
    ctx.fillStyle = serviceColor(row.service);
    ctx.font = '700 19px ui-monospace, sans-serif';
    ctx.fillText(serviceLabel(row.service), 118, y);
    ctx.fillStyle = '#e7edf2';
    ctx.font = '600 18px ui-monospace, sans-serif';
    ctx.fillText(row.destination, 188, y);
  }
  board.texture.needsUpdate = true;
}

function runModeAtStation(rt: CityRuntime, run: TrainRunLike, stationIndex: number): TrackMode {
  return run.service === 'local' && rt.lineStationHasPassingLoop(run.lineId, stationIndex) ? 'siding' : 'main';
}

function runMatchesBoard(rt: CityRuntime, board: CityBoard, run: TrainRunLike): boolean {
  if (run.lineId !== board.lineId || run.state === 'depot' || run.deadhead) return false;
  const line = rt.rail.lines[board.lineId];
  if (!line || runModeAtStation(rt, run, board.stationIndex) !== board.mode) return false;
  return line.kind !== 'trunk' || run.lane === board.lane;
}

function runStopsAt(rt: CityRuntime, run: TrainRunLike, stationIndex: number): boolean {
  return rt.shouldStop(run, stationIndex);
}

function destinationForRun(rt: CityRuntime, run: TrainRunLike): string {
  const line = rt.rail.lines[run.lineId];
  if (!line || line.stationIds.length === 0) return '行先未定';
  const terminalIndex = run.direction > 0 ? line.stationIds.length - 1 : 0;
  const stationId = line.stationIds[terminalIndex];
  const name = rt.rail.stations[stationId]?.name ?? `第${stationId + 1}駅`;
  return `${name} 行`;
}

function estimatedDepartureAt(rt: CityRuntime, board: CityBoard, run: TrainRunLike): number | null {
  const smooth = rt.smoothLines.get(board.lineId);
  if (!smooth || !runStopsAt(rt, run, board.stationIndex)) return null;

  if (run.currentStationIndex === board.stationIndex && (run.state === 'dwell' || run.state === 'schedule')) {
    if (run.scheduledDepartureAt > rt.railTime - 2) return Math.max(rt.railTime, run.scheduledDepartureAt);
    return rt.railTime + Math.max(0, run.dwellRemaining);
  }
  if (run.state !== 'running') return null;

  const targetDistance = smooth.stationDistances[board.stationIndex] ?? 0;
  const remaining = (targetDistance - run.distance) * run.direction;
  if (remaining < -4) return null;

  let arrival = 0;
  if (run.nextStationIndex === board.stationIndex && run.scheduledArrivalAt > 0) {
    arrival = Math.max(rt.railTime, run.scheduledArrivalAt);
  } else {
    const estimateSpeed = Math.max(8, Math.min(run.cruiseSpeed || 22, Math.max(run.speed, 14)) * 0.88);
    arrival = rt.railTime + Math.max(0, remaining) / estimateSpeed;
    if (run.nextStationIndex >= 0 && run.nextStationIndex !== board.stationIndex) {
      let intermediateStops = 0;
      for (let i = run.nextStationIndex; i !== board.stationIndex; i += run.direction) {
        if (i < 0 || i >= smooth.stationDistances.length) break;
        if (runStopsAt(rt, run, i)) intermediateStops++;
      }
      arrival += intermediateStops * 18;
    }
  }
  const stationDwell = run.service === 'limited' ? 12 : run.service === 'rapid' ? 15 : 18;
  return arrival + stationDwell;
}

function cityBoardDepartures(rt: CityRuntime, board: CityBoard): BoardDeparture[] {
  const departures: BoardDeparture[] = [];
  for (const run of rt.trainRuns) {
    if (!runMatchesBoard(rt, board, run)) continue;
    const time = estimatedDepartureAt(rt, board, run);
    if (time == null || time < rt.railTime - 3) continue;
    departures.push({ time, service: run.service, destination: destinationForRun(rt, run) });
  }
  departures.sort((a, b) => a.time - b.time || serviceLabel(a.service).localeCompare(serviceLabel(b.service)));
  return departures.slice(0, 3);
}

function cityBoardState(rt: CityRuntime, board: CityBoard): BoardState {
  const smooth = rt.smoothLines.get(board.lineId);
  if (!smooth) return '待機';
  const stationD = smooth.stationDistances[board.stationIndex] ?? 0;
  let approaching = false;
  let departing = false;

  for (const run of rt.trainRuns) {
    if (!runMatchesBoard(rt, board, run)) continue;
    if (run.currentStationIndex === board.stationIndex && (run.state === 'dwell' || run.state === 'schedule')) return '停車中';
    const delta = Math.abs(run.distance - stationD);
    if (run.originStationIndex === board.stationIndex && run.currentStationIndex < 0 && run.state === 'running' && delta <= 320) departing = true;
    if (run.nextStationIndex === board.stationIndex && delta <= 1000) approaching = true;
  }
  return departing ? '発車' : approaching ? '接近' : '待機';
}

function platformCenterOffset(rt: CityRuntime, line: RailLineLike, stationIndex: number, spec: { trackOffset: number }): number {
  const side = spec.trackOffset >= 0 ? 1 : -1;
  if (line.kind === 'trunk' && rt.lineStationHasPassingLoop(line.id, stationIndex)) {
    return side * ((MAIN_OFFSET + SIDING_OFFSET) * 0.5);
  }
  return spec.trackOffset + side * 4.10;
}

function buildCityBoards(rt: CityRuntime): CityBoard[] {
  const boards: CityBoard[] = [];
  const trackCounter = new Map<number, number>();
  for (const line of rt.rail.lines) {
    const smooth = rt.smoothLines.get(line.id);
    if (!smooth) continue;
    for (let stationIndex = 0; stationIndex < line.stationIds.length; stationIndex++) {
      const stationId = line.stationIds[stationIndex];
      const center = smooth.stationDistances[stationIndex] ?? 0;
      const baseShift = stationIndex % 2 === 0 ? BOARD_ALONG_SHIFT : -BOARD_ALONG_SHIFT;
      const specs: Array<{ lane: TrackLane; mode: TrackMode; trackOffset: number }> = [];
      if (line.kind === 'trunk') {
        specs.push({ lane: -1, mode: 'main', trackOffset: -MAIN_OFFSET });
        specs.push({ lane: 1, mode: 'main', trackOffset: MAIN_OFFSET });
        if (rt.lineStationHasPassingLoop(line.id, stationIndex)) {
          specs.push({ lane: -1, mode: 'siding', trackOffset: -SIDING_OFFSET });
          specs.push({ lane: 1, mode: 'siding', trackOffset: SIDING_OFFSET });
        }
      } else {
        specs.push({ lane: 0, mode: 'main', trackOffset: rt.sharedSpurOffset(smooth, center) });
      }

      for (const spec of specs) {
        const modeShift = spec.mode === 'siding' ? 5 : -5;
        const boardDistance = THREE.MathUtils.clamp(center + baseShift + modeShift, 0, smooth.length);
        const p = rt.sampleSmooth(smooth, center);
        if (!p) continue;
        const along = boardDistance - center;
        const boardOffset = platformCenterOffset(rt, line, stationIndex, spec);
        const visual = boardVisual(rt.scene, p.heading);
        visual.group.position.set(
          p.x + Math.cos(p.heading) * along - Math.sin(p.heading) * boardOffset,
          rt.lineTrackY(line.id) + BOARD_CENTER_HEIGHT,
          p.z + Math.sin(p.heading) * along + Math.cos(p.heading) * boardOffset,
        );
        const trackNo = (trackCounter.get(stationId) ?? 0) + 1;
        trackCounter.set(stationId, trackNo);
        const board: CityBoard = { ...visual, stationId, lineId: line.id, stationIndex, lane: spec.lane, mode: spec.mode, trackNo, lastSignature: '' };
        drawBoard(board, '待機');
        boards.push(board);
      }
    }
  }
  return boards;
}

function hsrBoardState(source: HighSpeedSource, direction: 1 | -1): BoardState {
  const route = source.route;
  if (!route) return '待機';
  let approaching = false;
  let departing = false;
  for (const train of source.trains ?? []) {
    if (train.direction !== direction) continue;
    const d = Math.abs(train.position - route.centralPosition);
    if (train.state === 'dwell' && d < 2) return '停車中';
    if (train.state === 'running' && train.stoppedAtCentral && d <= 450) departing = true;
    if (train.state === 'running' && !train.stoppedAtCentral && d <= 1600) approaching = true;
  }
  return departing ? '発車' : approaching ? '接近' : '待機';
}

function installHsrBoards(): void {
  const inspection = latestHighSpeedRailInspectionSource();
  const source = (inspection as unknown as HighSpeedAdapter | null)?.source;
  const route = source?.route;
  const pointAt = source?.pointAt?.bind(source);
  const scene = source?.rt?.scene;
  if (!source || !route || !pointAt || !scene || !source.syncMeshes) return;

  const boards: HsrBoard[] = [];
  for (const [index, direction] of ([1, -1] as const).entries()) {
    const trackOffset = direction > 0 ? HSR_TRACK_OFFSET : -HSR_TRACK_OFFSET;
    const side = trackOffset >= 0 ? 1 : -1;
    const p = pointAt(route.centralPosition, trackOffset + side * 3.7);
    const visual = boardVisual(scene, route.heading);
    visual.group.position.set(p.x, route.trackY + BOARD_CENTER_HEIGHT, p.z);
    const board: HsrBoard = { ...visual, direction, trackNo: index + 1, lastSignature: '' };
    drawBoard(board, '待機');
    boards.push(board);
  }

  const baseSync = source.syncMeshes.bind(source);
  source.syncMeshes = () => {
    baseSync();
    for (const board of boards) drawBoard(board, hsrBoardState(source, board.direction));
  };
  source.syncMeshes();
}

/** Add one very small, perpendicular ceiling-hung live departure display per platform track. */
export function installRailPlatformIndicators(renderer: RailRenderer): void {
  const rt = renderer as unknown as CityRuntime & { __citySimPlatformBoardsV032?: boolean };
  if (rt.__citySimPlatformBoardsV032) return;
  rt.__citySimPlatformBoardsV032 = true;
  const boards = buildCityBoards(rt);
  const baseUpdate = rt.updateTrainMeshes.bind(rt);
  let lastRefreshBucket = -1;
  rt.updateTrainMeshes = () => {
    baseUpdate();
    const bucket = Math.floor(rt.railTime / BOARD_REFRESH_SECONDS);
    if (bucket === lastRefreshBucket) return;
    lastRefreshBucket = bucket;
    for (const board of boards) drawBoard(board, cityBoardState(rt, board), cityBoardDepartures(rt, board));
  };
  rt.updateTrainMeshes();
  installHsrBoards();
}
