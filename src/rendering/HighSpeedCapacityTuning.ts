import { ExternalVisitorSystem } from '../world/ExternalVisitorSystem';
import { RailRenderer } from './RailRenderer';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type AnyHost = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const HIGH_SPEED_TRAIN_CAPACITY = 730;

interface HighSpeedTrainRuntime {
  passengerCapacity?: number;
  passengers?: number;
}

interface HighSpeedRuntimeSource extends AnyHost {
  trains?: HighSpeedTrainRuntime[];
  spawn?: (direction: 1 | -1, now: number) => void;
  updatePanel?: (force: boolean) => void;
}

function sourceRuntime(): HighSpeedRuntimeSource | null {
  const inspection = latestHighSpeedRailInspectionSource() as unknown as AnyHost | null;
  if (!inspection) return null;
  return (inspection.source ?? inspection) as HighSpeedRuntimeSource;
}

function normalizeTrain(train: HighSpeedTrainRuntime): void {
  train.passengerCapacity = HIGH_SPEED_TRAIN_CAPACITY;
  if (typeof train.passengers === 'number') {
    train.passengers = Math.max(0, Math.min(HIGH_SPEED_TRAIN_CAPACITY, train.passengers));
  }
}

function applyHighSpeedCapacity(): void {
  const source = sourceRuntime();
  if (!source) return;

  for (const train of source.trains ?? []) normalizeTrain(train);

  if (!source.__citySimCapacity730V051 && typeof source.spawn === 'function') {
    const previousSpawn = source.spawn.bind(source);
    source.spawn = (direction: 1 | -1, now: number): void => {
      previousSpawn(direction, now);
      for (const train of source.trains ?? []) normalizeTrain(train);
    };
    source.__citySimCapacity730V051 = true;
  }

  source.updatePanel?.(true);
}

function install(): void {
  // ExternalVisitorSystem receives the physical consist capacity from the HSR runtime.
  // v0.1.51 makes that contract fixed per train instead of deriving it from car count
  // or the current inbound load.
  const visitorProto = ExternalVisitorSystem.prototype as unknown as AnyHost;
  if (!visitorProto.__citySimHighSpeedCapacity730V051) {
    const previousExchange = visitorProto.exchangeAtStation as AnyMethod;
    visitorProto.exchangeAtStation = function exchangeAtStationWithFixedHighSpeedCapacity(
      this: ExternalVisitorSystem,
      stationId: number,
      _capacity: number,
      now: number,
      trainId: number,
    ): { arrived: number; boarded: number } {
      return previousExchange.call(this, stationId, HIGH_SPEED_TRAIN_CAPACITY, now, trainId) as { arrived: number; boarded: number };
    };
    visitorProto.__citySimHighSpeedCapacity730V051 = true;
  }

  const railProto = RailRenderer.prototype as unknown as AnyHost;
  if (!railProto.__citySimHighSpeedCapacityBuildV051) {
    const previousBuild = railProto.build as AnyMethod;
    railProto.build = function buildWithFixedHighSpeedCapacity(this: RailRenderer, ...args: any[]): any {
      const result = previousBuild.apply(this, args);
      applyHighSpeedCapacity();
      // Some external-rail decorators finish their registration at the end of the
      // same build call; a zero-delay pass is independent of simulation time.
      if (typeof window !== 'undefined') window.setTimeout(applyHighSpeedCapacity, 0);
      return result;
    };
    railProto.__citySimHighSpeedCapacityBuildV051 = true;
  }
}

install();
