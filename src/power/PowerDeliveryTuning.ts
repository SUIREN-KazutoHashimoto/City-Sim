import { PowerSystem } from './PowerSystem';
import {
  BuildingPowerState,
  PowerAssetState,
  PowerGridState,
  PowerLineState,
  PowerPriority,
} from './PowerTypes';

type AnyMethod = (...args: any[]) => any;
type RuntimePowerSystem = Record<string, any>;
type PowerConsumerRuntime = Record<string, any>;

const EPS = 0.001;

/**
 * Keep electrical connectivity/faults hard, but treat line and transformer nameplate ratings as
 * overload thresholds rather than instantaneous load-shedding limits.
 *
 * The base distributor used every line/substation rating as a hard per-tick cap. With thousands of
 * consumers this produced large blackouts even while the connected zone still had ample generation
 * and import capacity. Real equipment can carry overload for a period; protection/failure can be
 * modelled separately. For now, a healthy connected zone should deliver available power first and
 * report the equipment that is operating above rating.
 */
const proto = PowerSystem.prototype as unknown as Record<string, any>;
if (!proto.__citySimReliablePowerDeliveryV1019) {
  proto.distributePower = function distributePowerWithSoftEquipmentRatings(this: PowerSystem): void {
    const runtime = this as unknown as RuntimePowerSystem;
    const consumers = runtime.allConsumers() as PowerConsumerRuntime[];

    for (const segment of this.lineSegments) {
      segment.currentLoadKw = 0;
      segment.overload = false;
    }
    for (const substation of this.substations) {
      substation.demandKw = 0;
      substation.suppliedKw = 0;
      substation.utilization = 0;
      substation.overload = false;
    }
    for (const consumer of consumers) runtime.resetConsumer(consumer);

    const substationsById = new Map(this.substations.map((substation) => [substation.id, substation] as const));
    for (const consumer of consumers) {
      if (!consumer.substationId) continue;
      const substation = substationsById.get(consumer.substationId);
      if (substation) substation.demandKw += consumer.demandKw;
    }

    const zoneRemaining = runtime.zoneAvailableCapacityKw() as Float64Array;
    const orderedConsumers = [...consumers].sort((a, b) => {
      const aKey = typeof runtime.consumerKey === 'function' ? String(runtime.consumerKey(a)) : String(a.buildingId ?? a.id ?? '');
      const bKey = typeof runtime.consumerKey === 'function' ? String(runtime.consumerKey(b)) : String(b.buildingId ?? b.id ?? '');
      return a.priority - b.priority || a.zoneId - b.zoneId || aKey.localeCompare(bKey);
    });

    for (const priority of [PowerPriority.Critical, PowerPriority.High, PowerPriority.Medium, PowerPriority.Low]) {
      for (const consumer of orderedConsumers) {
        if (consumer.priority !== priority || consumer.demandKw <= EPS) continue;
        if (!consumer.substationId || consumer.zoneId < 0) {
          consumer.state = BuildingPowerState.Disconnected;
          continue;
        }

        const substation = substationsById.get(consumer.substationId);
        if (!substation
          || substation.state !== PowerAssetState.Online
          || !substation.sourceId
          || substation.zoneId !== consumer.zoneId) {
          consumer.state = BuildingPowerState.Blackout;
          continue;
        }

        const path = runtime.uniquePath(substation.sourcePathSegmentIds, consumer.distributionPathSegmentIds) as number[];
        let connected = true;
        for (const segmentId of path) {
          const segment = this.lineSegments[segmentId];
          if (!segment || segment.state !== PowerLineState.Active) {
            connected = false;
            break;
          }
        }
        if (!connected) {
          consumer.state = BuildingPowerState.Blackout;
          continue;
        }

        // Generation/import capacity is a hard limit. Healthy line/transformer ratings are soft:
        // they record overload after the flow is assigned instead of silently shedding consumers.
        const zoneCapacity = zoneRemaining[consumer.zoneId] ?? 0;
        const deliverable = Math.max(0, Math.min(consumer.demandKw, zoneCapacity));
        consumer.gridSuppliedKw = deliverable;

        if (deliverable > EPS) {
          zoneRemaining[consumer.zoneId] = Math.max(0, zoneCapacity - deliverable);
          substation.suppliedKw += deliverable;
          for (const segmentId of path) {
            const segment = this.lineSegments[segmentId];
            if (segment) segment.currentLoadKw += deliverable;
          }
        }
      }
    }

    // Ratings remain meaningful diagnostics and can later feed thermal trip/failure behaviour.
    for (const substation of this.substations) {
      substation.utilization = substation.capacityKw > EPS ? substation.suppliedKw / substation.capacityKw : 0;
      substation.overload = substation.capacityKw > EPS
        && Math.max(substation.demandKw, substation.suppliedKw) > substation.capacityKw + EPS;
    }
    for (const segment of this.lineSegments) {
      segment.overload = segment.state === PowerLineState.Active
        && segment.capacityKw > EPS
        && segment.currentLoadKw > segment.capacityKw + EPS;
    }

    runtime.applyEmergencyPower();
    runtime.updateConsumerStates();
    const gridSupplied = consumers.reduce((sum, consumer) => sum + consumer.gridSuppliedKw, 0);
    runtime.dispatchGenerationByZone();
    const demand = consumers.reduce((sum, consumer) => sum + consumer.demandKw, 0);

    if (demand <= EPS) runtime.gridState = PowerGridState.Normal;
    else if (gridSupplied / demand <= this.config.blackoutSupplyRatio) runtime.gridState = PowerGridState.Blackout;
    else if (gridSupplied + EPS < demand) runtime.gridState = PowerGridState.LimitedSupply;
    else runtime.gridState = (runtime.availableSystemCapacityKw() - demand) / demand < this.config.tightReserveMarginRatio
      ? PowerGridState.Tight
      : PowerGridState.Normal;
  } as AnyMethod;

  proto.__citySimReliablePowerDeliveryV1019 = true;
}
