import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };

type PlatformSpec = {
  stationId: number;
  stationIndex: number;
  lineId: number;
  center: number;
  length: number;
  offset: number;
  width: number;
  y: number;
  terminal: boolean;
};

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 10.0;
const TRAIN_HALF_WIDTH = 1.50;
const PLATFORM_CLEARANCE = 0.48;
const ROOF_CENTER_HEIGHT = 5.45;
const ROOF_UNDERSIDE_HEIGHT = 5.34;
const TERMINAL_MIN_LENGTH = 270;

const proto = RailRenderer.prototype as unknown as AnyRail;
const previousBuildStations = proto.buildStations as () => void;
const previousUpdateTrainMeshes = proto.updateTrainMeshes as () => void;

function platformWidth(kind: RailStationKind, terminal: boolean): number {
  if (terminal) return 4.4;
  return kind === RailStationKind.Central || kind === RailStationKind.SubCenter ? 4.2 : 3.8;
}

function geometryCenter(smooth: AnySmooth, stationIndex: number, length: number, terminal: boolean): number {
  const raw = smooth.stationDistances[stationIndex] ?? 0;
  if (!terminal) return raw;
  if (stationIndex === 0) return Math.min(smooth.length, length * 0.5);
  if (stationIndex === smooth.stationDistances.length - 1) return Math.max(0, smooth.length - length * 0.5);
  return raw;
}

function platformSpecs(self: AnyRail, line: AnyRail, stationId: number, stationIndex: number, rawLength: number, y: number): PlatformSpec[] {
  const station = self.rail.stations[stationId];
  const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
  if (!station || !smooth) return [];
  const terminal = station.kind === RailStationKind.Terminal && (stationIndex === 0 || stationIndex === line.stationIds.length - 1);
  const length = terminal ? Math.max(TERMINAL_MIN_LENGTH, rawLength) : rawLength;
  const center = geometryCenter(smooth, stationIndex, length, terminal);
  const width = platformWidth(station.kind as RailStationKind, terminal);

  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(line.id, stationIndex)) {
    const island = (MAIN_OFFSET + SIDING_OFFSET) * 0.5;
    return [-island, island].map((offset) => ({ stationId, stationIndex, lineId: line.id, center, length, offset, width, y, terminal }));
  }

  if (line.kind === 'trunk') {
    const offset = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
    return [-offset, offset].map((value) => ({ stationId, stationIndex, lineId: line.id, center, length, offset: value, width, y, terminal }));
  }

  const track = self.sharedSpurOffset(smooth, center) as number;
  const side = track >= 0 ? 1 : -1;
  const offset = track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5);
  return [{ stationId, stationIndex, lineId: line.id, center, length, offset, width, y, terminal }];
}

function pushRange(
  self: AnyRail,
  smooth: AnySmooth,
  distanceStart: number,
  distanceEnd: number,
  offset: number,
  y: number,
  height: number,
  width: number,
  parts: StaticPart[],
  step = 7.2,
): void {
  if (distanceEnd - distanceStart < 0.5) return;
  for (let s = distanceStart; s < distanceEnd - 0.01; s += step) {
    const e = Math.min(distanceEnd, s + step);
    const a = self.offsetPoint(smooth, s, offset) as { x: number; z: number } | null;
    const b = self.offsetPoint(smooth, e, offset) as { x: number; z: number } | null;
    if (a && b) self.pushRibbonSegment(a, b, y, height, width, parts);
  }
}

function buildPlatformDetails(
  self: AnyRail,
  smooth: AnySmooth,
  spec: PlatformSpec,
  terminalSlabs: StaticPart[],
  roofs: StaticPart[],
  pillars: StaticPart[],
  seats: StaticPart[],
  backs: StaticPart[],
  vending: StaticPart[],
  vendingFronts: StaticPart[],
  fluorescent: StaticPart[],
): void {
  const start = Math.max(0, spec.center - spec.length * 0.5);
  const end = Math.min(smooth.length, spec.center + spec.length * 0.5);
  if (end - start < 8) return;

  if (spec.terminal) pushRange(self, smooth, start, end, spec.offset, spec.y + 0.38, 0.38, spec.width, terminalSlabs);

  const canopyStart = start + 8;
  const canopyEnd = end - 8;
  pushRange(self, smooth, canopyStart, canopyEnd, spec.offset, spec.y + ROOF_CENTER_HEIGHT, 0.18, spec.width * 0.94, roofs, 7.2);

  for (let s = canopyStart + 4; s <= canopyEnd - 4; s += 12) {
    const p = self.offsetPoint(smooth, s, spec.offset) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    pillars.push({ matrix: self.matrix(p.x, spec.y + 2.92, p.z, 0.18, 4.70, 0.18) });
    fluorescent.push({ matrix: self.matrix(p.x, spec.y + ROOF_UNDERSIDE_HEIGHT, p.z, 2.45, 0.075, 0.22, -p.heading) });
  }

  const side = spec.offset >= 0 ? 1 : -1;
  for (let s = start + 28; s <= end - 28; s += 48) {
    if (Math.abs(s - spec.center) < 15) continue;
    const seatOffset = spec.offset + side * Math.min(0.72, spec.width * 0.18);
    const p = self.offsetPoint(smooth, s, seatOffset) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    seats.push({ matrix: self.matrix(p.x, spec.y + 0.88, p.z, 2.35, 0.18, 0.62, -p.heading) });
    const back = self.offsetPoint(smooth, s, seatOffset + side * 0.25) as { x: number; z: number; heading: number } | null;
    if (back) backs.push({ matrix: self.matrix(back.x, spec.y + 1.20, back.z, 2.35, 0.72, 0.13, -back.heading) });
  }

  for (const s of [spec.center - spec.length * 0.22, spec.center + spec.length * 0.22]) {
    if (s <= start + 5 || s >= end - 5) continue;
    const machineOffset = spec.offset - side * Math.min(0.75, spec.width * 0.20);
    const p = self.offsetPoint(smooth, s, machineOffset) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    vending.push({ matrix: self.matrix(p.x, spec.y + 1.48, p.z, 0.92, 1.82, 0.78, -p.heading) });
    const front = self.offsetPoint(smooth, s + 0.02, machineOffset - side * 0.40) as { x: number; z: number; heading: number } | null;
    if (front) vendingFronts.push({ matrix: self.matrix(front.x, spec.y + 1.52, front.z, 0.76, 1.45, 0.055, -front.heading) });
  }
}

function wallOffsets(self: AnyRail, line: AnyRail, stationId: number, stationIndex: number, center: number, width: number): number[] {
  if (line.kind !== 'trunk') {
    const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
    if (!smooth) return [];
    const track = self.sharedSpurOffset(smooth, center) as number;
    const side = track >= 0 ? 1 : -1;
    const platformCenter = track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5);
    return [platformCenter + side * (width * 0.5 + 0.18)];
  }

  if (self.lineStationHasPassingLoop(line.id, stationIndex)) {
    const wall = SIDING_OFFSET + TRAIN_HALF_WIDTH + 1.05;
    return [-wall, wall];
  }

  const platformCenter = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
  const wall = platformCenter + width * 0.5 + 0.18;
  return [-wall, wall];
}

function buildOuterShell(
  self: AnyRail,
  smooth: AnySmooth,
  spec: PlatformSpec,
  offsets: number[],
  lowerWalls: StaticPart[],
  glass: StaticPart[],
  fascia: StaticPart[],
): void {
  const start = Math.max(0, spec.center - spec.length * 0.5 + 8);
  const end = Math.min(smooth.length, spec.center + spec.length * 0.5 - 8);
  for (const offset of offsets) {
    pushRange(self, smooth, start, end, offset, spec.y + 1.35, 1.55, 0.18, lowerWalls, 7.2);
    pushRange(self, smooth, start, end, offset, spec.y + 3.46, 2.35, 0.12, glass, 7.2);
    pushRange(self, smooth, start, end, offset, spec.y + 5.00, 0.34, 0.24, fascia, 7.2);
  }
}

function buildStationArchitecture(self: AnyRail): void {
  const terminalSlabs: StaticPart[] = [];
  const roofs: StaticPart[] = [], pillars: StaticPart[] = [];
  const lowerWalls: StaticPart[] = [], glass: StaticPart[] = [], fascia: StaticPart[] = [];
  const seats: StaticPart[] = [], backs: StaticPart[] = [];
  const vending: StaticPart[] = [], vendingFronts: StaticPart[] = [], fluorescent: StaticPart[] = [];
  const lightStations = new Set<number>();
  const lights: THREE.PointLight[] = [];

  for (const line of self.rail.lines as AnyRail[]) {
    const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
    if (!smooth) continue;
    const y = self.lineTrackY(line.id) as number;

    for (let i = 0; i < line.stationIds.length; i++) {
      const stationId = line.stationIds[i];
      const station = self.rail.stations[stationId];
      if (!station) continue;
      const rawLength = self.platformLength(stationId) as number;
      const specs = platformSpecs(self, line, stationId, i, rawLength, y);
      if (!specs.length) continue;

      for (const spec of specs) {
        buildPlatformDetails(self, smooth, spec, terminalSlabs, roofs, pillars, seats, backs, vending, vendingFronts, fluorescent);
      }
      buildOuterShell(self, smooth, specs[0], wallOffsets(self, line, stationId, i, specs[0].center, specs[0].width), lowerWalls, glass, fascia);

      if (!lightStations.has(stationId) && station.kind !== RailStationKind.Local) {
        const p = self.sampleSmooth(smooth, specs[0].center) as { x: number; z: number } | null;
        if (p) {
          const light = new THREE.PointLight(0xf5f8ff, 0, 68, 2.0);
          light.position.set(p.x, y + 5.05, p.z);
          light.castShadow = false;
          self.scene.add(light);
          lights.push(light);
          lightStations.add(stationId);
        }
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0xc9c7bf, roughness: 0.86 }), terminalSlabs);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x697984, roughness: 0.52, metalness: 0.20 }), roofs);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x626d74, roughness: 0.65, metalness: 0.18 }), pillars);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x66727b, roughness: 0.82, metalness: 0.08 }), lowerWalls);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x263d4a, roughness: 0.22, metalness: 0.12, transparent: true, opacity: 0.52, depthWrite: false }), glass);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x485761, roughness: 0.64, metalness: 0.14 }), fascia);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x69747a, roughness: 0.72, metalness: 0.18 }), seats);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x5a656b, roughness: 0.72, metalness: 0.18 }), backs);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0xe8edf1, roughness: 0.42, metalness: 0.10 }), vending);
  self.addStatic(box.clone(), new THREE.MeshStandardMaterial({ color: 0x5bb4e6, roughness: 0.28, emissive: 0x163b54, emissiveIntensity: 1.2 }), vendingFronts);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, emissive: 0xf3f8ff, emissiveIntensity: 2.4 }), fluorescent);

  self.__citySimStationLightsV030 = lights;
}

function updateStationLights(self: AnyRail): void {
  const lights = self.__citySimStationLightsV030 as THREE.PointLight[] | undefined;
  if (!lights?.length) return;
  const t = ((self.railTime as number) % 86400 + 86400) % 86400;
  const hour = t / 3600;
  const night = hour >= 17.0 || hour < 6.5;
  const dusk = (hour >= 16.0 && hour < 17.0) || (hour >= 6.5 && hour < 7.0);
  const intensity = night ? 48 : dusk ? 18 : 3;
  for (const light of lights) light.intensity = intensity;
}

proto.buildStations = function buildStationsWithArchitecture(this: AnyRail): void {
  previousBuildStations.call(this);
  buildStationArchitecture(this);
};

proto.updateTrainMeshes = function updateTrainMeshesWithStationLighting(this: AnyRail): void {
  previousUpdateTrainMeshes.call(this);
  updateStationLights(this);
};
