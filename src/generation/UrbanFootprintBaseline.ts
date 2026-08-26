import { CityPlanning, type PlanningSample } from './CityPlanning';

type SampleMethod = (this: CityPlanning, x: number, z: number) => PlanningSample;

// Capture the pristine planner before diversity/park patches alter district metadata.
// The urbanScore is the city-footprint field and must stay identical to the pre-diversity generator.
const baseSample = CityPlanning.prototype.sample as SampleMethod;

export function baselinePlanningSample(planning: CityPlanning, x: number, z: number): PlanningSample {
  return baseSample.call(planning, x, z);
}
