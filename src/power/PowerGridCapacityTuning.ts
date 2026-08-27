import { PowerSystem } from './PowerSystem';
import { mwToKw } from './PowerTypes';

type AnyMethod = (...args: any[]) => any;
type RuntimePowerSystem = Record<string, any>;

interface CapacityState {
  baseCapacityKw: Float64Array;
}

const capacityStates = new WeakMap<PowerSystem, CapacityState>();

function capacityState(system: PowerSystem): CapacityState {
  let state = capacityStates.get(system);
  if (state && state.baseCapacityKw.length === system.lineSegments.length) return state;
  const baseCapacityKw = new Float64Array(system.lineSegments.length);
  for (const segment of system.lineSegments) baseCapacityKw[segment.id] = segment.capacityKw;
  state = { baseCapacityKw };
  capacityStates.set(system, state);
  return state;
}

function restoreBaseCapacities(system: PowerSystem): void {
  const state = capacityState(system);
  for (const segment of system.lineSegments) {
    const base = state.baseCapacityKw[segment.id];
    if (Number.isFinite(base) && base > 0) segment.capacityKw = base;
  }
}

/**
 * The base power topology reuses road edges as the logical electrical network. Road class is a
 * useful hint for the physical route, but it must not make a Local road's 55 MW rating the hard
 * bottleneck for an otherwise adequately-sized high-voltage/substation network.
 *
 * This layer separates the logical roles without replacing topology/fault handling:
 *  - source -> substation paths are bulk-transfer feeders with sourceFeederCapacityMw as a floor;
 *  - every segment used by a substation's distribution tree can carry at least that substation's
 *    transformer capacity;
 *  - broken lines still disconnect topology and substation capacity remains a hard limit.
 *
 * Capacity floors are recalculated from the original road-derived values on every topology rebuild,
 * so a temporary assignment does not permanently upgrade unrelated lines after a fault/re-route.
 */
const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerGridCapacityV1018) {
  const previousRebuildSourcePaths = proto.rebuildSourcePaths as AnyMethod;
  proto.rebuildSourcePaths = function rebuildSourcePathsWithBulkFeeders(this: PowerSystem): void {
    restoreBaseCapacities(this);
    previousRebuildSourcePaths.call(this);

    const runtime = this as unknown as RuntimePowerSystem;
    const sourceFloorKw = mwToKw(Math.max(0.1, this.config.sourceFeederCapacityMw));
    const net = runtime.net as { nodes: Array<{ edges: number[] }> };
    const roadEdgeToSegment = runtime.roadEdgeToSegment as Int32Array;

    // A substation must be able to inject up to its own transformer capacity onto the first
    // distribution segment, even when the coincident road happens to be a low-class street.
    for (const substation of this.substations) {
      const node = net.nodes[substation.roadNodeId];
      if (!node) continue;
      for (const edgeId of node.edges) {
        const segmentId = roadEdgeToSegment[edgeId];
        if (segmentId < 0) continue;
        const segment = this.lineSegments[segmentId];
        if (segment) segment.capacityKw = Math.max(segment.capacityKw, substation.capacityKw);
      }
    }

    // Source paths represent the higher-voltage bulk network.
    for (const substation of this.substations) {
      for (const segmentId of substation.sourcePathSegmentIds) {
        const segment = this.lineSegments[segmentId];
        if (segment) segment.capacityKw = Math.max(segment.capacityKw, sourceFloorKw);
      }

      let pathCapacity = substation.capacityKw;
      for (const segmentId of substation.sourcePathSegmentIds) {
        const segment = this.lineSegments[segmentId];
        if (segment) pathCapacity = Math.min(pathCapacity, segment.capacityKw);
      }
      substation.sourcePathCapacityKw = pathCapacity;
    }
  };

  const previousRebuildDistributionAssignments = proto.rebuildDistributionAssignments as AnyMethod;
  proto.rebuildDistributionAssignments = function rebuildDistributionAssignmentsWithSizedFeeders(this: PowerSystem): void {
    previousRebuildDistributionAssignments.call(this);

    const substations = new Map(this.substations.map((substation) => [substation.id, substation] as const));
    const raisePath = (substationId: string | null, path: readonly number[]): void => {
      if (!substationId) return;
      const substation = substations.get(substationId);
      if (!substation) return;
      for (const segmentId of path) {
        const segment = this.lineSegments[segmentId];
        if (!segment) continue;
        // The transformer is the intended distribution bottleneck. A road-derived logical edge
        // should not choke the feeder below the transformer's own nameplate capacity.
        segment.capacityKw = Math.max(segment.capacityKw, substation.capacityKw);
      }
    };

    for (const connection of this.buildingConnections.values()) {
      raisePath(connection.substationId, connection.distributionPathSegmentIds);
    }
    for (const load of this.infrastructureLoads) {
      raisePath(load.substationId, load.distributionPathSegmentIds);
    }
  };

  proto.__citySimPowerGridCapacityV1018 = true;
}
