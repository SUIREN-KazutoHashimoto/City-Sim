import { CityPlanning, type PlanningSample } from './CityPlanning';
import { baselinePlanningSample } from './UrbanFootprintBaseline';

type AnyPlanning = CityPlanning & Record<string, any>;
type SampleMethod = (this: AnyPlanning, x: number, z: number) => PlanningSample;

const proto = CityPlanning.prototype as unknown as Record<string, any>;
if (!proto.__citySimUrbanFootprintGuardV074) {
  const previousSample = proto.sample as SampleMethod;
  proto.sample = function sampleWithOriginalUrbanFootprint(this: AnyPlanning, x: number, z: number): PlanningSample {
    const tuned = previousSample.call(this, x, z);
    const baseline = baselinePlanningSample(this, x, z);
    if (tuned.urbanScore === baseline.urbanScore) return tuned;
    return {
      ...tuned,
      // Height mix, vacancy, parks and forests may change what occupies an already-urban block,
      // but they must not grow/shrink the map-wide urbanized footprint itself.
      urbanScore: baseline.urbanScore,
    };
  };
  proto.__citySimUrbanFootprintGuardV074 = true;
}
