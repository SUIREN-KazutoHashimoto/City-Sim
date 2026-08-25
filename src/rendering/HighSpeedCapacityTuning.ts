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

  if (!source.__citySimCapacity730V065 && typeof source.spawn === 'function') {
    const previousSpawn = source.spawn.bind(source);
    source.spawn = (direction: 1 | -1, now: number): void => {
      previousSpawn(direction, now);
      for (const train of source.trains ?? []) normalizeTrain(train);
    };
    source.__citySimCapacity730V065 = true;
  }

  source.updatePanel?.(true);
}

function install(): void {
  // The physical train capacity is fixed at 730. Passenger exchange deliberately keeps the
  // runtime's actual onboard count so the visitor system can disembark roughly half of the people
  // who are really on the arriving train, rather than half of the theoretical capacity.
  const railProto = RailRenderer.prototype as unknown as AnyHost;
  if (!railProto.__citySimHighSpeedCapacityBuildV065) {
    const previousBuild = railProto.build as AnyMethod;
    railProto.build = function buildWithFixedHighSpeedCapacity(this: RailRenderer, ...args: any[]): any {
      const result = previousBuild.apply(this, args);
      applyHighSpeedCapacity();
      if (typeof window !== 'undefined') window.setTimeout(applyHighSpeedCapacity, 0);
      return result;
    };
    railProto.__citySimHighSpeedCapacityBuildV065 = true;
  }
}

install();
