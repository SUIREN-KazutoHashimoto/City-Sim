import { RailRenderer } from './RailRenderer';

const CITY_RAIL_ACCEL_MPS2 = 3.0 / 3.6;
const CITY_RAIL_BRAKE_MPS2 = 4.2 / 3.6;

interface MutableRailRendererConstructor {
  ACCEL: number;
  BRAKE: number;
}

let prepared = false;

/**
 * Apply the requested city-rail acceleration and service-brake rates before railway operation.
 *
 * RailRenderer keeps these as private static runtime fields. They are normal writable JavaScript
 * class properties after compilation, so changing the constructor values here updates every
 * acceleration and braking calculation without duplicating the train movement algorithm.
 */
export function prepareRailMotionTuning(): void {
  if (prepared) return;
  prepared = true;

  const ctor = RailRenderer as unknown as MutableRailRendererConstructor;
  ctor.ACCEL = CITY_RAIL_ACCEL_MPS2;
  ctor.BRAKE = CITY_RAIL_BRAKE_MPS2;
}
