import * as THREE from 'three';
import { AgentState } from '../agents/AgentStore';
import type { World } from '../world/World';
import { latestRailPassengerProvider } from './RailPassengerBridge';
import {
  densityColor, divergingColor, gridIndex, muted, routeColor, setCoverage, setMarker, severityColor, updateMesh,
  type ExpansionState, type OverlayInternals,
} from './CityDiagnosticOverlayExpansionCommon';

function nearestStation(stations: readonly { id: number; x: number; z: number }[], x: number, z: number): number {
  let best = -1, bestD = Infinity;
  for (const station of stations) { const d = (station.x-x)**2 + (station.z-z)**2; if (d < bestD) { bestD = d; best = station.id; } }
  return best;
}

export function refreshTransitLoad(state: ExpansionState, world: World): void {
  const ui = state.manager as unknown as OverlayInternals;
  const busLoad = new Map<number, number>(); let busOnboard = 0;
  for (let id = 0; id < world.bus.busCount; id++) { const status = world.bus.busStatus(id); if (!status) continue; const load = status.capacity > 0 ? status.onboard.length / status.capacity : 0; busOnboard += status.onboard.length; busLoad.set(status.routeId, Math.max(busLoad.get(status.routeId) ?? 0, load)); }
  const provider = latestRailPassengerProvider(), railLoad = new Map<number, number>(); let railOnboard = 0;
  if (provider) {
    const renderer = provider as unknown as { trainStatus?: (id: number) => { lineId: number } | null };
    const countRail = (world as unknown as { railTrainPassengerCount?: (id: number) => number }).railTrainPassengerCount;
    for (const train of provider.passengerTrainPositions()) { const passengers = countRail?.call(world, train.id) ?? 0; railOnboard += passengers; const lineId = renderer.trainStatus?.(train.id)?.lineId ?? -1; if (lineId >= 0) railLoad.set(lineId, Math.max(railLoad.get(lineId) ?? 0, passengers / Math.max(1, train.capacity))); }
  }
  state.routeSegments.forEach((s, i) => { const load = s.kind === 'bus' ? busLoad.get(s.routeId) : railLoad.get(s.routeId); state.routeMesh.setColorAt(i, load == null ? routeColor(s.routeId, s.kind) : severityColor(load)); }); updateMesh(state.routeMesh);

  const busWait = new Uint32Array(world.bus.stops.length), stations = world.city.planning.rail.stations, railWait = new Uint32Array(stations.length); let waitingBus = 0, waitingRail = 0;
  for (let a = 0; a < world.store.count; a++) {
    if (world.store.state[a] === AgentState.WaitingBus) { const stop = world.store.boardStop[a]; if (stop >= 0 && stop < busWait.length) busWait[stop]++; waitingBus++; }
    else if (world.store.state[a] === AgentState.WaitingTrain) { const station = nearestStation(stations, world.store.posX[a], world.store.posZ[a]); if (station >= 0) railWait[station]++; waitingRail++; }
  }
  let marker = 0, maxWait = 0;
  for (const stop of world.bus.stops) { const wait = busWait[stop.id] ?? 0; maxWait = Math.max(maxWait, wait); setMarker(state.markerMesh, marker++, stop.x, stop.z, 2.4 + Math.sqrt(wait)*0.5, 2.8, severityColor(wait/28)); }
  for (const station of stations) { const wait = railWait[station.id] ?? 0; maxWait = Math.max(maxWait, wait); setMarker(state.markerMesh, marker++, station.x, station.z, 3.6 + Math.sqrt(wait)*0.65, 4.2, severityColor(wait/65), 0.6); }
  state.markerMesh.count = marker; updateMesh(state.markerMesh);
  ui.summary.textContent = `待ち バス${waitingBus} / 鉄道${waitingRail} / 車内 バス${busOnboard} / 鉄道${railOnboard} / 最大待ち${maxWait}`;
}

export type TransitWalkDistances = (state: ExpansionState, world: World) => Float64Array;
export function refreshTransitCoverage(state: ExpansionState, world: World, walkDistances: TransitWalkDistances): void {
  const ui = state.manager as unknown as OverlayInternals;
  state.routeSegments.forEach((s, i) => state.routeMesh.setColorAt(i, routeColor(s.routeId, s.kind))); updateMesh(state.routeMesh);
  let marker = 0, coverage = 0;
  for (const stop of world.bus.stops) { setMarker(state.markerMesh, marker++, stop.x, stop.z, 2.5, 2.5, routeColor(stop.routes[0] ?? 0, 'bus')); setCoverage(state.coverageMesh, coverage++, stop.x, stop.z, 350, new THREE.Color(0x4fa7d8)); }
  for (const station of world.city.planning.rail.stations) { setMarker(state.markerMesh, marker++, station.x, station.z, 3.6, 4, routeColor(station.lineIds[0] ?? station.id, 'rail'), 0.6); setCoverage(state.coverageMesh, coverage++, station.x, station.z, 850, new THREE.Color(0x8e66d8)); }
  state.markerMesh.count = marker; state.coverageMesh.count = coverage; updateMesh(state.markerMesh); updateMesh(state.coverageMesh);

  if (state.transitCoverageRatio == null) {
    const distances = walkDistances(state, world), homeNode = new Map<number, number>(); let covered = 0, known = 0;
    for (let a = 0; a < world.store.count; a++) { const home = world.store.homePOI[a]; if (home < 0) continue; let node = homeNode.get(home); if (node == null) { const p = world.city.poi.get(home); node = world.sidewalk.nearestNode(p.x, p.z); homeNode.set(home, node); } if (node < 0) continue; known++; if (distances[node] <= 600) covered++; }
    state.transitCoverageRatio = known > 0 ? covered / known : 0;
  }
  ui.summary.textContent = `バス路線${world.bus.routes.length} / バス停${world.bus.stops.length} / 鉄道路線${world.city.planning.rail.lines.length} / 駅${world.city.planning.rail.stations.length} / 居住者10分徒歩圏 ${(state.transitCoverageRatio * 100).toFixed(1)}%`;
}

export function refreshPopulation(state: ExpansionState, world: World, dayNight: boolean): void {
  const ui = state.manager as unknown as OverlayInternals, cells = state.gridCols * state.gridRows, current = new Uint32Array(cells), store = world.store;
  for (let a = 0; a < store.count; a++) current[gridIndex(state, store.posX[a], store.posZ[a])]++;
  if (!state.homeCellCounts || state.homeCellCounts.length !== cells) { state.homeCellCounts = new Uint32Array(cells); for (let a = 0; a < store.count; a++) { const home = store.homePOI[a]; if (home < 0) continue; const p = world.city.poi.get(home); state.homeCellCounts[gridIndex(state, p.x, p.z)]++; } }
  let maxCurrent = 1, maxAbsDelta = 1, moving = 0, densest = 0;
  for (let i = 0; i < cells; i++) { if (current[i] > maxCurrent) { maxCurrent = current[i]; densest = i; } maxAbsDelta = Math.max(maxAbsDelta, Math.abs(current[i] - state.homeCellCounts[i])); }
  for (let a = 0; a < store.count; a++) if (store.state[a] !== AgentState.Idle && store.state[a] !== AgentState.Engaged) moving++;
  for (let i = 0; i < cells; i++) { const color = dayNight ? divergingColor((current[i]-state.homeCellCounts[i])/maxAbsDelta) : densityColor(Math.sqrt(current[i]/maxCurrent)); state.gridMesh.setColorAt(i, current[i] === 0 && (!dayNight || state.homeCellCounts[i] === 0) ? muted : color); }
  updateMesh(state.gridMesh); const gx = densest % state.gridCols, gz = Math.floor(densest/state.gridCols);
  ui.summary.textContent = `${dayNight ? '現在−居住人口差' : '現在人口密度'} / 人口${store.count} / 移動中${moving} / 最大セル${maxCurrent}人 @(${gx},${gz}) / 時刻 ${world.clock.hourF.toFixed(2)}h`;
}
