import * as THREE from 'three';
import { RailNetworkPlan, RailStationKind } from '../generation/RailPlanning';
import { RailRenderer } from './RailRenderer';

type AnyPlan = Record<string, any>;
type AnyRail = Record<string, any>;
type AnyRun = Record<string, any>;
type AnySmooth = Record<string, any>;
type RailPointLike = { x: number; z: number };
type RailCenterLike = { x: number; z: number };
type StationLike = {
  id: number;
  name: string;
  plannedX: number;
  plannedZ: number;
  kind: RailStationKind;
  lineIds: number[];
  influenceRadius: number;
};

const planProto = RailNetworkPlan.prototype as unknown as Record<string, any>;

/**
 * Keep spur construction deterministic and useful after the 1.5x station-spacing change.
 * A spur must branch from a trunk station and, when it exists, contain at least two stations
 * beyond the junction. Very short candidates are represented by promoting the nearest trunk
 * station instead of creating a one-stop stub.
 */
if (!planProto.__citySimSpurPlanningV037) {
  planProto.__citySimSpurPlanningV037 = true;

  planProto.buildSubCenterSpur = function stableSubCenterSpur(
    this: AnyPlan,
    center: RailCenterLike,
    subIndex: number,
  ): void {
    const stations = this.stations as StationLike[];
    const trunkStations = stations.filter((station) => station.lineIds.some((lineId) => this.lines[lineId]?.kind === 'trunk'));
    if (!trunkStations.length) return;

    const nonTerminal = trunkStations.filter((station) => station.kind !== RailStationKind.Terminal);
    const candidates = nonTerminal.length ? nonTerminal : trunkStations;
    let nearest = candidates[0];
    let best = Infinity;
    for (const station of candidates) {
      const distance = Math.hypot(station.plannedX - center.x, station.plannedZ - center.z);
      if (distance < best) {
        best = distance;
        nearest = station;
      }
    }

    const standardSpacing = Math.max(320, this.options.railStationSpacing * 0.90);
    const minimumUsefulLength = Math.max(520, standardSpacing * 0.78);
    if (best < minimumUsefulLength) {
      if (nearest.kind !== RailStationKind.Central) {
        nearest.kind = RailStationKind.SubCenter;
        nearest.name = `副都心${subIndex + 1}駅`;
      }
      nearest.influenceRadius = Math.max(nearest.influenceRadius, this.options.railInfluenceRadius * 1.15);
      return;
    }

    const dx = center.x - nearest.plannedX;
    const dz = center.z - nearest.plannedZ;
    const length = Math.hypot(dx, dz);
    if (length < 1) return;

    // ceil() keeps each leg at or below the target spacing; max(2) guarantees one intermediate
    // station, so a real spur has junction + intermediate + subcenter at minimum.
    const segmentCount = Math.max(2, Math.ceil(length / standardSpacing));
    const stationIds: number[] = [nearest.id];
    const pushUnique = (id: number): void => {
      if (!stationIds.includes(id)) stationIds.push(id);
    };

    for (let segment = 1; segment < segmentCount; segment++) {
      const t = segment / segmentCount;
      pushUnique(this.ensureStation(
        nearest.plannedX + dx * t,
        nearest.plannedZ + dz * t,
        RailStationKind.Local,
        '',
      ) as number);
    }

    const destinationId = this.ensureStation(
      center.x,
      center.z,
      RailStationKind.SubCenter,
      `副都心${subIndex + 1}駅`,
    ) as number;
    pushUnique(destinationId);

    // With the minimum length above the midpoint cannot collapse into either endpoint through
    // ensureStation's 120 m merge radius. Keep this guard for unusual future planning settings.
    if (stationIds.length < 3) {
      const destination = stations[destinationId];
      if (destination && destination.kind !== RailStationKind.Central) {
        destination.kind = RailStationKind.SubCenter;
        destination.name = `副都心${subIndex + 1}駅`;
        destination.influenceRadius = Math.max(destination.influenceRadius, this.options.railInfluenceRadius * 1.15);
      }
      return;
    }

    this.addLine(`副都心支線${subIndex + 1}`, 'spur', stationIds);
  };
}

const railProto = RailRenderer.prototype as unknown as Record<string, any>;

if (!railProto.__citySimSpurRuntimeV037) {
  railProto.__citySimSpurRuntimeV037 = true;

  /**
   * The old helper projected every spur point by its coordinate along the trunk axis. For a branch
   * close to perpendicular, many far-away points have almost the same trunk-axis coordinate, so an
   * entire branch could be pulled into the interchange and collapse into a degenerate path.
   * The road-A* path is already continuous; use it directly and let sharedSpurOffset handle only
   * the local lateral separation required for interchange platforms.
   */
  railProto.sharedStationSafePath = function unwarpedSpurPath(
    this: AnyRail,
    line: { path: RailPointLike[] },
  ): RailPointLike[] {
    return line.path.map((point) => ({ x: point.x, z: point.z }));
  };

  const baseTrainTrackOffset = railProto.trainTrackOffset as
    ((run: AnyRun, smooth: AnySmooth, distance: number) => number) | undefined;
  if (baseTrainTrackOffset) {
    railProto.trainTrackOffset = function spurTrackOffsetMatchesRail(
      this: AnyRail,
      run: AnyRun,
      smooth: AnySmooth,
      distance: number,
    ): number {
      if (smooth.line?.kind === 'spur') {
        // buildTrackGeometry() uses trackOffsetAt(..., lane=0) for the physical spur rail.
        // Use that exact function for service trains as well so no later terminal/siding patch can
        // move a spur train away from the rail that is actually visible.
        return this.trackOffsetAt(smooth, 0, THREE.MathUtils.clamp(distance, 0, smooth.length)) as number;
      }
      return baseTrainTrackOffset.call(this, run, smooth, distance);
    };
  }
}
