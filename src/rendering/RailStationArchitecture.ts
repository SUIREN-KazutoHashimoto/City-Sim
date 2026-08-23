import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnySmooth = Record<string, any>;
type StaticPart = { matrix: THREE.Matrix4 };

type PlatformSpec = {
  stationId: number;
  lineId: number;
  center: number;
  length: number;
  offset: number;
  width: number;
  y: number;
};

const MAIN_OFFSET = 1.72;
const SIDING_OFFSET = 8.0;
const TRAIN_HALF_WIDTH = 2.86 * 0.5;
const PLATFORM_CLEARANCE = 0.48;
const proto = RailRenderer.prototype as unknown as AnyRail;
const previousBuildStations = proto.buildStations as () => void;

function platformWidth(kind: RailStationKind): number {
  return kind === RailStationKind.Central || kind === RailStationKind.SubCenter ? 4.2 : 3.8;
}

function platformSpecs(self: AnyRail, line: AnyRail, stationId: number, stationIndex: number, center: number, length: number, y: number): PlatformSpec[] {
  const station = self.rail.stations[stationId];
  const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
  if (!station || !smooth) return [];
  const width = platformWidth(station.kind as RailStationKind);

  if (line.kind === 'trunk' && self.lineStationHasPassingLoop(line.id, stationIndex)) {
    const island = (MAIN_OFFSET + SIDING_OFFSET) * 0.5;
    return [-island, island].map((offset) => ({ stationId, lineId: line.id, center, length, offset, width, y }));
  }

  if (line.kind === 'trunk') {
    const offset = MAIN_OFFSET + TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5;
    return [-offset, offset].map((value) => ({ stationId, lineId: line.id, center, length, offset: value, width, y }));
  }

  const track = self.sharedSpurOffset(smooth, center) as number;
  const side = track >= 0 ? 1 : -1;
  const offset = track + side * (TRAIN_HALF_WIDTH + PLATFORM_CLEARANCE + width * 0.5);
  return [{ stationId, lineId: line.id, center, length, offset, width, y }];
}

function pushFacadeRange(
  self: AnyRail,
  smooth: AnySmooth,
  spec: PlatformSpec,
  start: number,
  end: number,
  lowerWalls: StaticPart[],
  glass: StaticPart[],
  fascia: StaticPart[],
  roofCaps: StaticPart[],
): void {
  if (end - start < 1.5) return;
  const side = spec.offset >= 0 ? 1 : -1;
  const outer = spec.offset + side * (spec.width * 0.5 + 0.12);
  const roofOffset = spec.offset + side * 0.16;

  for (let s = start; s < end - 0.01; s += 6.4) {
    const e = Math.min(end, s + 6.4);
    const a = self.offsetPoint(smooth, s, outer) as { x: number; z: number; heading: number } | null;
    const b = self.offsetPoint(smooth, e, outer) as { x: number; z: number; heading: number } | null;
    const ra = self.offsetPoint(smooth, s, roofOffset) as { x: number; z: number; heading: number } | null;
    const rb = self.offsetPoint(smooth, e, roofOffset) as { x: number; z: number; heading: number } | null;
    if (!a || !b || !ra || !rb) continue;

    // 壁は薄板として外周だけに置く。駅内部を埋める箱にはしない。
    self.pushRibbonSegment(a, b, spec.y + 1.04, 0.92, 0.18, lowerWalls);
    self.pushRibbonSegment(a, b, spec.y + 2.18, 1.18, 0.12, glass);
    self.pushRibbonSegment(a, b, spec.y + 3.18, 0.42, 0.22, fascia);
    self.pushRibbonSegment(ra, rb, spec.y + 3.52, 0.16, spec.width * 0.92, roofCaps);
  }
}

function buildPlatformShell(
  self: AnyRail,
  smooth: AnySmooth,
  spec: PlatformSpec,
  lowerWalls: StaticPart[],
  glass: StaticPart[],
  fascia: StaticPart[],
  frames: StaticPart[],
  roofCaps: StaticPart[],
  signs: StaticPart[],
): void {
  const start = Math.max(0, spec.center - spec.length * 0.5);
  const end = Math.min(smooth.length as number, spec.center + spec.length * 0.5);
  const shellStart = start + 11;
  const shellEnd = end - 11;
  const centerGap = 5.8;

  // 中央部は地上・乗換階段用の開口として残す。
  pushFacadeRange(self, smooth, spec, shellStart, Math.min(shellEnd, spec.center - centerGap), lowerWalls, glass, fascia, roofCaps);
  pushFacadeRange(self, smooth, spec, Math.max(shellStart, spec.center + centerGap), shellEnd, lowerWalls, glass, fascia, roofCaps);

  const side = spec.offset >= 0 ? 1 : -1;
  const outer = spec.offset + side * (spec.width * 0.5 + 0.12);
  for (let s = shellStart; s <= shellEnd + 0.01; s += 8.0) {
    if (Math.abs(s - spec.center) < centerGap + 0.8) continue;
    const p = self.offsetPoint(smooth, s, outer) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    frames.push({ matrix: self.matrix(p.x, spec.y + 2.02, p.z, 0.20, 2.95, 0.20) });
  }

  // 妻面は上部だけにして、ホーム端の通行と線路側を塞がない。
  for (const d of [shellStart, shellEnd]) {
    const p = self.offsetPoint(smooth, d, spec.offset) as { x: number; z: number; heading: number } | null;
    if (!p) continue;
    const endWidth = Math.max(1.8, spec.width * 0.78);
    frames.push({ matrix: self.matrix(p.x, spec.y + 3.18, p.z, endWidth, 0.38, 0.22, -p.heading + Math.PI / 2) });
  }

  const signPoint = self.offsetPoint(smooth, spec.center, outer) as { x: number; z: number; heading: number } | null;
  if (signPoint) {
    signs.push({ matrix: self.matrix(signPoint.x, spec.y + 2.95, signPoint.z, 5.2, 0.72, 0.16, -signPoint.heading) });
  }
}

function buildStationArchitecture(self: AnyRail): void {
  const lowerWalls: StaticPart[] = [];
  const glass: StaticPart[] = [];
  const fascia: StaticPart[] = [];
  const frames: StaticPart[] = [];
  const roofCaps: StaticPart[] = [];
  const signs: StaticPart[] = [];

  for (const line of self.rail.lines as AnyRail[]) {
    const smooth = self.smoothLines.get(line.id) as AnySmooth | undefined;
    if (!smooth) continue;
    const y = self.lineTrackY(line.id) as number;

    for (let i = 0; i < line.stationIds.length; i++) {
      const stationId = line.stationIds[i];
      const station = self.rail.stations[stationId];
      if (!station) continue;
      const center = smooth.stationDistances[i] ?? 0;
      const length = self.platformLength(stationId) as number;
      for (const spec of platformSpecs(self, line, stationId, i, center, length, y)) {
        buildPlatformShell(self, smooth, spec, lowerWalls, glass, fascia, frames, roofCaps, signs);
      }
    }
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x66727b, roughness: 0.82, metalness: 0.08 }), lowerWalls);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x263d4a, roughness: 0.22, metalness: 0.12, transparent: true, opacity: 0.52, depthWrite: false }), glass);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x485761, roughness: 0.64, metalness: 0.14 }), fascia);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x5d6870, roughness: 0.62, metalness: 0.18 }), frames);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x596770, roughness: 0.56, metalness: 0.16 }), roofCaps);
  self.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x245f92, roughness: 0.48 }), signs);
}

proto.buildStations = function buildStationsWithArchitecture(this: AnyRail): void {
  previousBuildStations.call(this);
  buildStationArchitecture(this);
};
