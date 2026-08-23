import * as THREE from 'three';
import { RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type TerminalHost = { lineId: number; end: 0 | 1; stationId: number };

const DEPOT_TRACKS = 4;
const DEPOT_TRACK_GAP = 4.4;
const DEPOT_SIDE_OFFSET = 13.0;
const DEPOT_LEAD = 28;
const DEPOT_LADDER = 62;
const DEPOT_TRACK_END = 820;
const DEPOT_SLOT_SPACING = 58;

const proto = RailRenderer.prototype as unknown as AnyRail;

function terminalHosts(self: AnyRail): TerminalHost[] {
  const candidates: Array<TerminalHost & { trunk: boolean }> = [];
  for (const line of self.rail.lines) {
    if (!line?.stationIds?.length) continue;
    const ends: Array<0 | 1> = [0, 1];
    for (const end of ends) {
      const stationId = line.stationIds[end === 0 ? 0 : line.stationIds.length - 1];
      const station = self.rail.stations[stationId];
      if (station?.kind !== RailStationKind.Terminal) continue;
      candidates.push({ lineId: line.id, end, stationId, trunk: line.kind === 'trunk' });
    }
  }

  // 同じ物理終端駅へ複数路線が入る場合は、幹線を優先して基地を1か所だけ生成する。
  candidates.sort((a, b) => Number(b.trunk) - Number(a.trunk) || a.lineId - b.lineId || a.end - b.end);
  const seen = new Set<number>();
  const hosts: TerminalHost[] = [];
  for (const c of candidates) {
    if (seen.has(c.stationId)) continue;
    seen.add(c.stationId);
    hosts.push({ lineId: c.lineId, end: c.end, stationId: c.stationId });
  }
  return hosts;
}

function depotHostForRun(self: AnyRail, run: AnyRun): TerminalHost | null {
  const hosts = terminalHosts(self);
  if (!hosts.length) return null;

  const line = self.rail.lines[run.lineId];
  if (!line?.stationIds?.length) return hosts[0];
  const serviceStationId = line.stationIds[run.depotEnd === 0 ? 0 : line.stationIds.length - 1];
  const serviceStation = self.rail.stations[serviceStationId];

  const exact = hosts.find((h) => h.stationId === serviceStationId);
  if (exact) return exact;

  const serviceY = self.lineTrackY(run.lineId) as number;
  let best = hosts[0], bestScore = Infinity;
  for (const host of hosts) {
    const station = self.rail.stations[host.stationId];
    if (!station || !serviceStation) continue;
    const hostY = self.lineTrackY(host.lineId) as number;
    const distance = Math.hypot(station.x - serviceStation.x, station.z - serviceStation.z);
    const score = distance + Math.abs(hostY - serviceY) * 180;
    if (score < bestScore) { bestScore = score; best = host; }
  }
  return best;
}

function pushTrack(
  self: AnyRail,
  a: { x: number; z: number },
  b: { x: number; z: number },
  y: number,
  ballast: { matrix: THREE.Matrix4 }[],
  rails: { matrix: THREE.Matrix4 }[],
  width: number,
): void {
  self.pushTrackSegment(a, b, y, ballast, rails, width);
}

proto.buildDepots = function terminalOnlyDepots(this: AnyRail): void {
  const ballast: { matrix: THREE.Matrix4 }[] = [], rails: { matrix: THREE.Matrix4 }[] = [];
  const sheds: { matrix: THREE.Matrix4 }[] = [], apron: { matrix: THREE.Matrix4 }[] = [];

  for (const host of terminalHosts(this)) {
    const line = this.rail.lines[host.lineId];
    const smooth = this.smoothLines.get(host.lineId);
    if (!line || !smooth || smooth.path.length < 2) continue;

    const baseD = host.end === 0 ? 0 : smooth.length;
    const base = this.sampleSmooth(smooth, baseD); if (!base) continue;
    const y = this.lineTrackY(host.lineId) as number;
    const outward = host.end === 0 ? -1 : 1;
    const sideSign = ((host.lineId + host.end) & 1) === 0 ? 1 : -1;
    const makePoint = (along: number, lateral: number): { x: number; z: number } => ({
      x: base.x + Math.cos(base.heading) * outward * along - Math.sin(base.heading) * lateral,
      z: base.z + Math.sin(base.heading) * outward * along + Math.cos(base.heading) * lateral,
    });

    // 終端駅の先だけに、共通入出庫線→ラダー→4本の留置線を配置する。
    const throat = makePoint(DEPOT_LEAD, sideSign * 3.0);
    const ladder = makePoint(DEPOT_LADDER, sideSign * 9.0);
    pushTrack(this, { x: base.x, z: base.z }, throat, y, ballast, rails, 3.0);
    pushTrack(this, throat, ladder, y, ballast, rails, 3.0);

    for (let track = 0; track < DEPOT_TRACKS; track++) {
      const off = sideSign * (DEPOT_SIDE_OFFSET + track * DEPOT_TRACK_GAP);
      const branch = makePoint(88, off);
      const endPoint = makePoint(DEPOT_TRACK_END, off);
      pushTrack(this, ladder, branch, y, ballast, rails, 2.8);
      pushTrack(this, branch, endPoint, y, ballast, rails, 3.2);
    }

    const shedOff = sideSign * (DEPOT_SIDE_OFFSET + 3.5 * DEPOT_TRACK_GAP);
    const shed = makePoint(330, shedOff);
    sheds.push({ matrix: this.matrix(shed.x, y + 2.6, shed.z, 150, 5.2, 9.0, -base.heading) });
    const yard = makePoint(410, sideSign * 21);
    apron.push({ matrix: this.matrix(yard.x, y - 0.20, yard.z, 760, 0.18, 42, -base.heading) });
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.95 }), ballast);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.38, metalness: 0.72 }), rails);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x66717a, roughness: 0.72, metalness: 0.18 }), sheds);
  this.addStatic(box, new THREE.MeshStandardMaterial({ color: 0x555b60, roughness: 0.96 }), apron);
};

proto.depotBasePose = function sharedTerminalDepotPose(this: AnyRail, run: AnyRun): { x: number; z: number; heading: number } | null {
  const host = depotHostForRun(this, run); if (!host) return null;
  const smooth = this.smoothLines.get(host.lineId); if (!smooth) return null;
  const base = this.sampleSmooth(smooth, host.end === 0 ? 0 : smooth.length); if (!base) return null;

  const outward = host.end === 0 ? -1 : 1;
  const heading = this.wrapAngle(base.heading + (outward < 0 ? Math.PI : 0));
  const sideSign = ((host.lineId + host.end) & 1) === 0 ? 1 : -1;
  const track = Math.abs(run.id) % DEPOT_TRACKS;
  const slot = Math.floor(Math.abs(run.id) / DEPOT_TRACKS);
  const off = sideSign * (DEPOT_SIDE_OFFSET + track * DEPOT_TRACK_GAP);
  const along = 126 + slot * DEPOT_SLOT_SPACING;
  return {
    x: base.x + Math.cos(base.heading) * outward * along - Math.sin(base.heading) * off,
    z: base.z + Math.sin(base.heading) * outward * along + Math.cos(base.heading) * off,
    heading,
  };
};
