import * as THREE from 'three';
import type { RailRenderer } from './RailRenderer';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type TrackLane = -1 | 0 | 1;
type TrackMode = 'main' | 'siding';
type BoardState = '接近' | '停車中' | '発車' | '待機';

interface RailLineLike { id: number; kind: 'trunk' | 'spur'; stationIds: number[]; }
interface SmoothLineLike { length: number; stationDistances: number[]; }
interface TrainRunLike {
  id: number;
  lineId: number;
  service: 'local' | 'rapid' | 'limited';
  state: 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';
  direction: 1 | -1;
  distance: number;
  lane: TrackLane;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
}

interface CityRuntime {
  scene: THREE.Scene;
  rail: { lines: RailLineLike[]; stations: Array<{ id?: number } | undefined> };
  trainRuns: TrainRunLike[];
  smoothLines: Map<number, SmoothLineLike>;
  updateTrainMeshes: () => void;
  lineTrackY: (lineId: number) => number;
  sampleSmooth: (smooth: SmoothLineLike, distance: number) => { x: number; z: number; heading: number } | null;
  sharedSpurOffset: (smooth: SmoothLineLike, distance: number) => number;
  lineStationHasPassingLoop: (lineId: number, stationIndex: number) => boolean;
}

interface CityBoard {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  stationId: number;
  lineId: number;
  stationIndex: number;
  lane: TrackLane;
  mode: TrackMode;
  trackNo: number;
  lastState: BoardState | '';
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
interface HsrBoard {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  direction: 1 | -1;
  trackNo: number;
  lastState: BoardState | '';
}

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const HSR_TRACK_OFFSET = 2.4;

function boardVisual(scene: THREE.Scene): { sprite: THREE.Sprite; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: false, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(5.8, 1.45, 1);
  sprite.renderOrder = 4;
  scene.add(sprite);
  return { sprite, canvas, texture };
}

function drawBoard(board: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; trackNo: number; lastState: BoardState | '' }, state: BoardState): void {
  if (board.lastState === state) return;
  board.lastState = state;
  const ctx = board.canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#090b0e';
  ctx.fillRect(0, 0, board.canvas.width, board.canvas.height);
  ctx.strokeStyle = '#777';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, board.canvas.width - 8, board.canvas.height - 8);
  const color = state === '接近' ? '#ffb020' : state === '停車中' ? '#54f070' : state === '発車' ? '#55c8ff' : '#88909a';
  ctx.fillStyle = '#dfe7ef';
  ctx.font = 'bold 42px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${board.trackNo}番線`, 28, 64);
  ctx.fillStyle = color;
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText(state, 220, 64);
  board.texture.needsUpdate = true;
}

function cityBoardState(rt: CityRuntime, board: CityBoard): BoardState {
  const smooth = rt.smoothLines.get(board.lineId);
  const line = rt.rail.lines[board.lineId];
  if (!smooth || !line) return '待機';
  const stationD = smooth.stationDistances[board.stationIndex] ?? 0;
  let approaching = false;
  let departing = false;

  for (const run of rt.trainRuns) {
    if (run.lineId !== board.lineId || run.state === 'depot') continue;
    const runMode: TrackMode = run.service === 'local' && rt.lineStationHasPassingLoop(run.lineId, board.stationIndex) ? 'siding' : 'main';
    if (runMode !== board.mode) continue;
    if (line.kind === 'trunk' && run.lane !== board.lane) continue;

    if (run.currentStationIndex === board.stationIndex && (run.state === 'dwell' || run.state === 'schedule')) return '停車中';
    const delta = Math.abs(run.distance - stationD);
    if (run.originStationIndex === board.stationIndex && run.currentStationIndex < 0 && run.state === 'running' && delta <= 320) departing = true;
    if (run.nextStationIndex === board.stationIndex && delta <= 1000) approaching = true;
  }
  return departing ? '発車' : approaching ? '接近' : '待機';
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
        const p = rt.sampleSmooth(smooth, center);
        if (!p) continue;
        const side = spec.trackOffset >= 0 ? 1 : -1;
        const boardOffset = spec.trackOffset + side * 4.0;
        const visual = boardVisual(rt.scene);
        visual.sprite.position.set(
          p.x - Math.sin(p.heading) * boardOffset,
          rt.lineTrackY(line.id) + 4.5,
          p.z + Math.cos(p.heading) * boardOffset,
        );
        const trackNo = (trackCounter.get(stationId) ?? 0) + 1;
        trackCounter.set(stationId, trackNo);
        const board: CityBoard = { ...visual, stationId, lineId: line.id, stationIndex, lane: spec.lane, mode: spec.mode, trackNo, lastState: '' };
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
    const p = pointAt(route.centralPosition, trackOffset + side * 4.2);
    const visual = boardVisual(scene);
    visual.sprite.position.set(p.x, route.trackY + 5.0, p.z);
    const board: HsrBoard = { ...visual, direction, trackNo: index + 1, lastState: '' };
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

/** Add one simple live approach/dwell/departure display per physical platform track. */
export function installRailPlatformIndicators(renderer: RailRenderer): void {
  const rt = renderer as unknown as CityRuntime & { __citySimPlatformBoardsV027?: boolean };
  if (rt.__citySimPlatformBoardsV027) return;
  rt.__citySimPlatformBoardsV027 = true;
  const boards = buildCityBoards(rt);
  const baseUpdate = rt.updateTrainMeshes.bind(rt);
  rt.updateTrainMeshes = () => {
    baseUpdate();
    for (const board of boards) drawBoard(board, cityBoardState(rt, board));
  };
  rt.updateTrainMeshes();
  installHsrBoards();
}
