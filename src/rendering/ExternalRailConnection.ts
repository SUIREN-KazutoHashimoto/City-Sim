import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { latestExternalVisitorSystem, type ExternalVisitorSystem } from '../world/ExternalVisitorSystem';
import { RailRenderer } from './RailRenderer';

type TrackLane = -1 | 0 | 1;
type TrainState = 'depot' | 'dwell' | 'running' | 'signal' | 'schedule';

interface ExternalRun {
  id: number;
  lineId: number;
  service: 'local' | 'rapid' | 'limited';
  carCount: number;
  cruiseSpeed: number;
  currentSpeedLimit: number;
  direction: 1 | -1;
  speed: number;
  distance: number;
  currentStationIndex: number;
  originStationIndex: number;
  nextStationIndex: number;
  dwellRemaining: number;
  scheduledDepartureAt: number;
  scheduledArrivalAt: number;
  arrivalDelaySeconds: number;
  waitingSince: number;
  trainOrdinal: number;
  state: TrainState;
  lane: TrackLane;
  previousLane: TrackLane;
  laneChangeStationIndex: number;
  blocked: boolean;
  caution: boolean;
  reserve: boolean;
  retireAtTerminal: boolean;
  depotEnd: 0 | 1;
  depotTrack: number;
  depotSlot: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  externalConnection?: boolean;
}

interface ExternalRailRuntime {
  __citySimExternalRailV017?: boolean;
  railTime: number;
  rail: {
    sizeMeters: number;
    lines: Array<{ id: number; name: string; kind: 'trunk' | 'spur'; stationIds: number[] }>;
    stations: Array<{ id: number; name: string; kind: RailStationKind }>;
  };
  scene: THREE.Scene;
  trainRuns: ExternalRun[];
  trainInstanceToRun: number[];
  smoothLines: Map<number, { length: number }>;
  trainBody: THREE.InstancedMesh | null;
  trainStripe: THREE.InstancedMesh | null;
  trainCabin: THREE.InstancedMesh | null;
  shouldStop: (run: ExternalRun, stationIndex: number) => boolean;
  stopAtStation: (run: ExternalRun, stationIndex: number, stationId: number) => void;
  stepOperations: (dt: number) => void;
  trainStatus: (id: number) => Record<string, any> | null;
  timetableRows: () => Array<Record<string, any>>;
  lineTrackY: (lineId: number) => number;
  trainRouteColor: (lineId: number) => THREE.Color;
  rebuildDispatchReservations: () => void;
  updateTrainMeshes: () => void;
}

const EXTERNAL_CARS = 6;
const EXTERNAL_CAPACITY_PER_CAR = 120;
const EXTERNAL_CRUISE_SPEED = 33;

function isExternal(run: ExternalRun | undefined): boolean {
  return !!run?.externalConnection;
}

function addExternalRuns(rt: ExternalRailRuntime): number {
  let added = 0;
  for (const line of rt.rail.lines) {
    if (line.kind !== 'trunk' || line.stationIds.length < 3) continue;
    const smooth = rt.smoothLines.get(line.id); if (!smooth) continue;
    for (const end of [0, 1] as const) {
      const direction: 1 | -1 = end === 0 ? 1 : -1;
      const sameEnd = rt.trainRuns.filter((r) => r.lineId === line.id && r.depotEnd === end).length;
      const id = rt.trainRuns.length;
      const lane: TrackLane = direction;
      rt.trainRuns.push({
        id,
        lineId: line.id,
        service: 'limited',
        carCount: EXTERNAL_CARS,
        cruiseSpeed: EXTERNAL_CRUISE_SPEED,
        currentSpeedLimit: EXTERNAL_CRUISE_SPEED,
        direction,
        speed: 0,
        distance: end === 0 ? 0 : smooth.length,
        currentStationIndex: -1,
        originStationIndex: -1,
        nextStationIndex: -1,
        dwellRemaining: 0,
        scheduledDepartureAt: rt.railTime,
        scheduledArrivalAt: 0,
        arrivalDelaySeconds: 0,
        waitingSince: -1,
        trainOrdinal: 8 + line.id * 2 + end,
        state: 'depot',
        lane,
        previousLane: lane,
        laneChangeStationIndex: -1,
        blocked: false,
        caution: false,
        reserve: false,
        retireAtTerminal: false,
        depotEnd: end,
        depotTrack: sameEnd % 4,
        depotSlot: Math.floor(sameEnd / 4) + 1,
        x: 0,
        y: rt.lineTrackY(line.id),
        z: 0,
        heading: 0,
        externalConnection: true,
      });
      added++;
    }
  }
  return added;
}

/** RailRenderer creates proxy meshes at exact fleet capacity, so extend them after adding services. */
function rebuildTrainProxyMeshes(rt: ExternalRailRuntime): void {
  for (const mesh of [rt.trainBody, rt.trainStripe, rt.trainCabin]) if (mesh) rt.scene.remove(mesh);
  const capacity = Math.max(1, rt.trainRuns.reduce((sum, run) => sum + run.carCount, 0));
  const box = new THREE.BoxGeometry(1, 1, 1);
  rt.trainBody = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.18, vertexColors: true }),
    capacity,
  );
  rt.trainStripe = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.10, vertexColors: true }),
    capacity,
  );
  rt.trainCabin = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.22, metalness: 0.22, vertexColors: true }),
    capacity,
  );

  rt.trainInstanceToRun.length = 0;
  let instance = 0;
  for (const run of rt.trainRuns) {
    const route = rt.trainRouteColor(run.lineId);
    for (let car = 0; car < run.carCount; car++) {
      rt.trainInstanceToRun[instance] = run.id;
      rt.trainBody.setColorAt(instance, new THREE.Color(run.externalConnection ? 0xf2f5f7 : run.service === 'local' ? 0xdfe5e8 : 0xf5f7f9));
      rt.trainStripe.setColorAt(instance, run.externalConnection ? new THREE.Color(0x7a5be8) : route);
      rt.trainCabin.setColorAt(instance, route.clone().lerp(new THREE.Color(0x102235), 0.72));
      instance++;
    }
  }

  for (const mesh of [rt.trainBody, rt.trainStripe, rt.trainCabin]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(rt.rail.sizeMeters / 2, 8.2, rt.rail.sizeMeters / 2),
      Math.max(20_000, rt.rail.sizeMeters * 2),
    );
    rt.scene.add(mesh);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  rt.updateTrainMeshes();
}

function createVisitorPanel(externalTrainCount: number): { update: (system: ExternalVisitorSystem | null) => void } {
  if (typeof document === 'undefined') return { update: () => undefined };
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'top:220px', 'right:8px', 'z-index:14', 'width:320px',
    'padding:7px 8px', 'border:1px solid #3f3b69', 'border-radius:8px',
    'background:rgba(12,12,24,.82)', 'color:#d9d7ef', 'font:11px/1.4 ui-monospace,monospace',
    'pointer-events:none', 'white-space:pre-line',
  ].join(';');
  document.body.appendChild(el);
  return {
    update: (system) => {
      const s = system?.stats();
      if (!s) {
        el.textContent = `外部接続列車 ${externalTrainCount}編成\n来訪者モデル 準備中`;
        return;
      }
      el.textContent = `外部接続列車 ${externalTrainCount}編成  来訪者 ${s.active.toLocaleString()}人\n`
        + `買物 ${s.shopping.toLocaleString()}  観光 ${s.tourism.toLocaleString()}  宿泊 ${s.hotelGuests.toLocaleString()}\n`
        + `帰路待ち ${s.waitingOutbound.toLocaleString()}  今日 入${s.arrivedToday.toLocaleString()} / 出${s.departedToday.toLocaleString()}`;
    },
  };
}

/**
 * Add intercity/external-connection services on top of existing trunk lines. The map-edge terminal
 * and yard represent the off-map gateway; the service uses the normal blocks/interlocking in town.
 */
export function installExternalRailConnection(renderer: RailRenderer): void {
  const rt = renderer as unknown as ExternalRailRuntime;
  if (rt.__citySimExternalRailV017) return;
  rt.__citySimExternalRailV017 = true;

  const externalTrainCount = addExternalRuns(rt);
  if (externalTrainCount > 0) rebuildTrainProxyMeshes(rt);

  const visitorSystem = latestExternalVisitorSystem();
  const panel = createVisitorPanel(externalTrainCount);
  let lastPanelAt = -Infinity;

  const baseShouldStop = rt.shouldStop.bind(rt);
  const baseStopAtStation = rt.stopAtStation.bind(rt);
  const baseStepOperations = rt.stepOperations.bind(rt);
  const baseTrainStatus = rt.trainStatus.bind(rt);
  const baseTimetableRows = rt.timetableRows.bind(rt);

  rt.shouldStop = (run, stationIndex) => {
    if (!isExternal(run)) return baseShouldStop(run, stationIndex);
    const line = rt.rail.lines[run.lineId];
    const stationId = line?.stationIds[stationIndex] ?? -1;
    const station = stationId >= 0 ? rt.rail.stations[stationId] : null;
    return station?.kind === RailStationKind.Terminal
      || station?.kind === RailStationKind.Central
      || station?.kind === RailStationKind.SubCenter;
  };

  rt.stopAtStation = (run, stationIndex, stationId) => {
    baseStopAtStation(run, stationIndex, stationId);
    if (!isExternal(run) || !visitorSystem) return;
    const station = rt.rail.stations[stationId];
    if (!station || (station.kind !== RailStationKind.Central && station.kind !== RailStationKind.SubCenter)) return;
    visitorSystem.exchangeAtStation(stationId, run.carCount * EXTERNAL_CAPACITY_PER_CAR, rt.railTime, run.id);
    panel.update(visitorSystem);
    lastPanelAt = rt.railTime;
  };

  rt.stepOperations = (dt) => {
    baseStepOperations(dt);
    visitorSystem?.advanceTo(rt.railTime);
    if (rt.railTime - lastPanelAt >= 30) {
      panel.update(visitorSystem);
      lastPanelAt = rt.railTime;
    }
  };

  rt.trainStatus = (id) => {
    const status = baseTrainStatus(id);
    const run = rt.trainRuns[id];
    if (status && isExternal(run)) {
      status.serviceLabel = '外部接続';
      status.lineName = `${status.lineName}・外部直通`;
    }
    return status;
  };

  rt.timetableRows = () => {
    const rows = baseTimetableRows();
    for (const row of rows) {
      const run = rt.trainRuns[row.trainId];
      if (isExternal(run)) {
        row.serviceLabel = '外部接続';
        row.lineName = `${row.lineName}・外部直通`;
      }
    }
    return rows;
  };

  rt.rebuildDispatchReservations();
  panel.update(visitorSystem);
  console.info('[City-Sim] external rail connection', {
    trains: externalTrainCount,
    trunkLines: rt.rail.lines.filter((line) => line.kind === 'trunk').length,
  });
}
