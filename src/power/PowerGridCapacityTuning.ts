import { PowerSystem } from './PowerSystem';
import { mwToKw } from './PowerTypes';

type AnyMethod = (...args: any[]) => any;
type RuntimePowerSystem = Record<string, any>;

/**
 * Bulk source paths and the immediate substation feeder are not ordinary local-distribution lines.
 * The base topology reuses road edges for all electrical paths, so without this layer a plant that
 * happens to sit on a Local road can be throttled to the Local-line rating (55 MW by default).
 *
 * Keep neighborhood branches at their normal road-class rating, but raise:
 *  - source -> substation bulk-transfer paths to sourceFeederCapacityMw
 *  - segments immediately adjacent to a substation to at least that substation's own capacity
 */
const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimPowerGridCapacityV1017) {
  const previousRebuildSourcePaths = proto.rebuildSourcePaths as AnyMethod;
  proto.rebuildSourcePaths = function rebuildSourcePathsWithBulkFeeders(this: PowerSystem): void {
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

    // Source paths represent the higher-voltage bulk network. Raise the path floor while leaving
    // the consumer-side distribution branches at their original road-class capacities.
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

  proto.__citySimPowerGridCapacityV1017 = true;
}
