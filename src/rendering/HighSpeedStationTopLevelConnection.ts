import * as THREE from 'three';
import type { ExternalVisitorStationAccess, ExternalVisitorStationPoint } from '../world/ExternalVisitorSystem';
import { latestExternalVisitorSystem } from '../world/ExternalVisitorSystem';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';
import { RailRenderer } from './RailRenderer';
import './RailPassengerStationAccess';
import type { RailPassengerStationAccess } from './RailPassengerStationAccess';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

interface HsrRouteRuntime {
  ax: number;
  az: number;
  ux: number;
  uz: number;
  heading: number;
  trackY: number;
  centralPosition: number;
}

interface HsrSourceRuntime extends AnyHost {
  route?: HsrRouteRuntime;
  central?: { id: number; lineIds?: number[] };
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
}

const PLATFORM_SIDE = 6.45;
const PLATFORM_WAIT_Y_OFFSET = 0.60;
const PLATFORM_LINK_SPAN = 165;
const CONNECTOR_WIDTH = 3.2;
const CONNECTOR_NAME = 'hsr-central-platform-connector';

function runtimeSource(): HsrSourceRuntime | null {
  const inspection = latestHighSpeedRailInspectionSource() as unknown as AnyHost | null;
  if (!inspection) return null;
  return (inspection.source ?? inspection) as HsrSourceRuntime;
}

function matrixBox(x: number, y: number, z: number, length: number, height: number, width: number, heading: number): THREE.Matrix4 {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.rotation.y = -heading;
  o.scale.set(length, height, width);
  o.updateMatrix();
  return o.matrix.clone();
}

function topConventionalAccess(
  renderer: RailRenderer,
  stationId: number,
  lineIds: number[],
  x: number,
  z: number,
): RailPassengerStationAccess | null {
  let best: RailPassengerStationAccess | null = null;
  let bestY = -Infinity;
  let bestDistance = Infinity;
  for (const lineId of lineIds) {
    for (const direction of [1, -1] as const) {
      for (const access of renderer.passengerStationAccesses(stationId, lineId, direction)) {
        const landing = access.platformLanding;
        const distance = Math.hypot(landing.x - x, landing.z - z);
        if (landing.y > bestY + 0.2 || (Math.abs(landing.y - bestY) <= 0.2 && distance < bestDistance)) {
          best = access;
          bestY = landing.y;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

function connectorMatrices(points: ExternalVisitorStationPoint[]): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (let segment = 0; segment + 1 < points.length; segment++) {
    const a = points[segment], b = points[segment + 1];
    const dx = b.x - a.x, dz = b.z - a.z, dy = b.y - a.y;
    const horizontal = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(Math.max(horizontal / 2.7, Math.abs(dy) / 0.23)));
    const heading = horizontal > 1e-5 ? Math.atan2(dz, dx) : 0;
    const stepLength = Math.max(0.8, horizontal / steps + 0.18);
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      out.push(matrixBox(
        a.x + dx * t,
        a.y + dy * ((i + 1) / steps) - 0.10,
        a.z + dz * t,
        stepLength,
        0.20,
        CONNECTOR_WIDTH,
        heading,
      ));
    }
  }
  return out;
}

function replaceConnectorVisual(scene: THREE.Scene, accesses: ExternalVisitorStationAccess[]): void {
  const old: THREE.Object3D[] = [];
  scene.traverse((object) => { if (object.name === CONNECTOR_NAME) old.push(object); });
  for (const object of old) object.parent?.remove(object);

  const matrices: THREE.Matrix4[] = [];
  for (const access of accesses) matrices.push(...connectorMatrices([access.platformLanding, ...access.connector]));
  if (!matrices.length) return;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.86, metalness: 0.04 }),
    matrices.length,
  );
  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = CONNECTOR_NAME;
  scene.add(mesh);
}

function buildAccess(renderer: RailRenderer, source: HsrSourceRuntime, direction: 1 | -1): ExternalVisitorStationAccess | null {
  const route = source.route, central = source.central, pointAt = source.pointAt?.bind(source);
  if (!route || !central || !pointAt) return null;

  const side = direction > 0 ? PLATFORM_SIDE : -PLATFORM_SIDE;
  const waitRaw = pointAt(route.centralPosition, side);
  const conventional = topConventionalAccess(renderer, central.id, central.lineIds ?? [], waitRaw.x, waitRaw.z);
  if (!conventional) return null;
  const target = conventional.platformLanding;

  const projected = (target.x - route.ax) * route.ux + (target.z - route.az) * route.uz;
  const landingS = THREE.MathUtils.clamp(projected, route.centralPosition - PLATFORM_LINK_SPAN, route.centralPosition + PLATFORM_LINK_SPAN);
  const landingRaw = pointAt(landingS, side);
  const innerRaw = pointAt(landingS, side * 0.46);
  const platformY = route.trackY + PLATFORM_WAIT_Y_OFFSET;
  const upperY = Math.max(target.y + 4.0, route.trackY - 4.2);
  const bridgeY = Math.max(target.y + 1.1, route.trackY - 9.0);
  const connector: ExternalVisitorStationPoint[] = [
    { x: innerRaw.x, y: upperY, z: innerRaw.z },
    { x: (innerRaw.x + target.x) * 0.5, y: bridgeY, z: (innerRaw.z + target.z) * 0.5 },
    { x: target.x, y: target.y, z: target.z },
  ];

  return {
    stationId: central.id,
    direction,
    heading: route.heading,
    platformWait: { x: waitRaw.x, y: platformY, z: waitRaw.z },
    platformLanding: { x: landingRaw.x, y: platformY, z: landingRaw.z },
    connector,
    waitSpan: 180,
  };
}

function installTopLevelConnection(renderer: RailRenderer, rebuildVisual: boolean): void {
  const source = runtimeSource();
  if (!source) return;
  const accesses = ([1, -1] as const)
    .map((direction) => buildAccess(renderer, source, direction))
    .filter((access): access is ExternalVisitorStationAccess => access !== null);
  if (!accesses.length) return;

  latestExternalVisitorSystem()?.registerHighSpeedStationAccess(accesses, renderer);
  if (!rebuildVisual) return;
  const scene = (source.rt?.scene ?? (renderer as unknown as AnyHost).scene) as THREE.Scene | undefined;
  if (scene) replaceConnectorVisual(scene, accesses);
}

const proto = RailRenderer.prototype as unknown as AnyHost;
if (!proto.__citySimHsrTopPlatformConnectionV102) {
  const previousBuild = proto.build as AnyMethod;
  proto.build = function buildWithTopPlatformHsrConnection(this: RailRenderer, ...args: any[]): any {
    const result = previousBuild.apply(this, args);
    installTopLevelConnection(this, true);
    // The legacy connector also schedules a zero-delay registration. Run after it so the corrected
    // top-platform route remains the active passenger route.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => installTopLevelConnection(this, true), 0);
      window.setTimeout(() => installTopLevelConnection(this, false), 80);
    }
    return result;
  };
  proto.__citySimHsrTopPlatformConnectionV102 = true;
}
