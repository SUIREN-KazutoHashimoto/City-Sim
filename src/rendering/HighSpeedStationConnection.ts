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

function runtimeSource(): HsrSourceRuntime | null {
  const inspection = latestHighSpeedRailInspectionSource() as unknown as AnyHost | null;
  if (!inspection) return null;
  return (inspection.source ?? inspection) as HsrSourceRuntime;
}

function matrixBox(
  x: number,
  y: number,
  z: number,
  length: number,
  height: number,
  width: number,
  heading: number,
): THREE.Matrix4 {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  object.rotation.y = -heading;
  object.scale.set(length, height, width);
  object.updateMatrix();
  return object.matrix.clone();
}

function closestConventionalAccess(
  renderer: RailRenderer,
  stationId: number,
  lineIds: number[],
  x: number,
  z: number,
): RailPassengerStationAccess | null {
  let best: RailPassengerStationAccess | null = null;
  let bestDistance = Infinity;
  for (const lineId of lineIds) {
    for (const direction of [1, -1] as const) {
      for (const access of renderer.passengerStationAccesses(stationId, lineId, direction)) {
        const distance = Math.hypot(access.concourse.x - x, access.concourse.z - z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = access;
        }
      }
    }
  }
  return best;
}

function connectorMatrices(points: ExternalVisitorStationPoint[]): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (let segment = 0; segment + 1 < points.length; segment++) {
    const a = points[segment];
    const b = points[segment + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dy = b.y - a.y;
    const horizontal = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(Math.max(horizontal / 2.7, Math.abs(dy) / 0.23)));
    const heading = horizontal > 1e-5 ? Math.atan2(dz, dx) : 0;
    const stepLength = Math.max(0.8, horizontal / steps + 0.18);
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const y = a.y + dy * ((i + 1) / steps) - 0.10;
      out.push(matrixBox(x, y, z, stepLength, 0.20, CONNECTOR_WIDTH, heading));
    }
  }
  return out;
}

function addConnectorVisual(scene: THREE.Scene, matrices: THREE.Matrix4[]): void {
  if (!matrices.length) return;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.86, metalness: 0.04 }),
    matrices.length,
  );
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'hsr-central-platform-connector';
  scene.add(mesh);
}

function buildAccess(
  renderer: RailRenderer,
  source: HsrSourceRuntime,
  direction: 1 | -1,
): ExternalVisitorStationAccess | null {
  const route = source.route;
  const central = source.central;
  const pointAt = source.pointAt?.bind(source);
  if (!route || !central || !pointAt) return null;

  const side = direction > 0 ? PLATFORM_SIDE : -PLATFORM_SIDE;
  const waitRaw = pointAt(route.centralPosition, side);
  const conventional = closestConventionalAccess(
    renderer,
    central.id,
    central.lineIds ?? [],
    waitRaw.x,
    waitRaw.z,
  );
  if (!conventional) return null;

  const projected = (conventional.concourse.x - route.ax) * route.ux
    + (conventional.concourse.z - route.az) * route.uz;
  const landingS = THREE.MathUtils.clamp(
    projected,
    route.centralPosition - PLATFORM_LINK_SPAN,
    route.centralPosition + PLATFORM_LINK_SPAN,
  );
  const landingRaw = pointAt(landingS, side);
  const innerRaw = pointAt(landingS, side * 0.46);
  const platformY = route.trackY + PLATFORM_WAIT_Y_OFFSET;
  const upperY = Math.max(conventional.concourse.y + 5.0, route.trackY - 4.2);
  const bridgeY = Math.max(conventional.concourse.y + 1.2, route.trackY - 9.0);
  const connector: ExternalVisitorStationPoint[] = [
    { x: innerRaw.x, y: upperY, z: innerRaw.z },
    {
      x: (innerRaw.x + conventional.concourse.x) * 0.5,
      y: bridgeY,
      z: (innerRaw.z + conventional.concourse.z) * 0.5,
    },
    { ...conventional.concourse },
  ];

  return {
    stationId: central.id,
    direction,
    heading: route.heading,
    platformWait: { x: waitRaw.x, y: platformY, z: waitRaw.z },
    platformLanding: { x: landingRaw.x, y: platformY, z: landingRaw.z },
    connector,
    waitSpan: 300,
  };
}

function installStationConnection(renderer: RailRenderer): void {
  const source = runtimeSource();
  if (!source) return;
  const accesses = ([1, -1] as const)
    .map((direction) => buildAccess(renderer, source, direction))
    .filter((access): access is ExternalVisitorStationAccess => access !== null);
  if (!accesses.length) return;

  latestExternalVisitorSystem()?.registerHighSpeedStationAccess(accesses, renderer);

  if (source.__citySimHsrStationConnectionV065) return;
  const scene = (source.rt?.scene ?? (renderer as unknown as AnyHost).scene) as THREE.Scene | undefined;
  if (scene) {
    const matrices: THREE.Matrix4[] = [];
    for (const access of accesses) {
      matrices.push(...connectorMatrices([access.platformLanding, ...access.connector]));
    }
    addConnectorVisual(scene, matrices);
  }
  source.__citySimHsrStationConnectionV065 = true;
}

const proto = RailRenderer.prototype as unknown as AnyHost;
if (!proto.__citySimHsrStationConnectionBuildV065) {
  const previousBuild = proto.build as AnyMethod;
  proto.build = function buildWithHighSpeedStationConnection(this: RailRenderer, ...args: any[]): any {
    const result = previousBuild.apply(this, args);
    installStationConnection(this);
    if (typeof window !== 'undefined') window.setTimeout(() => installStationConnection(this), 0);
    return result;
  };
  proto.__citySimHsrStationConnectionBuildV065 = true;
}
