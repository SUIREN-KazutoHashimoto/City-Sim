import * as THREE from 'three';

export interface HighSpeedTrainStatusSnapshot {
  id: number;
  lineName: string;
  carCount: number;
  consistLength: number;
  stateLabel: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  maxSpeed: number;
  direction: 1 | -1;
  stoppedAtCentral: boolean;
  dwellRemaining: number;
  firstPersonForwardOffset: number;
}

export interface HighSpeedRailInspectionSource {
  readonly trainHitMesh: THREE.InstancedMesh;
  trainIdFromInstance(instanceId: number): number;
  trainStatus(id: number): HighSpeedTrainStatusSnapshot | null;
}

let currentSource: HighSpeedRailInspectionSource | null = null;

export function registerHighSpeedRailInspectionSource(source: HighSpeedRailInspectionSource | null): void {
  currentSource = source;
}

export function latestHighSpeedRailInspectionSource(): HighSpeedRailInspectionSource | null {
  return currentSource;
}
