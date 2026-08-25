import { CityPlanning, DistrictType, type PlanningSample } from './CityPlanning';

type AnyPlanning = CityPlanning & Record<string, any>;
type SampleMethod = (this: AnyPlanning, x: number, z: number) => PlanningSample;

const proto = CityPlanning.prototype as unknown as Record<string, any>;
if (!proto.__citySimParkExtractionV069) {
  const previousSample = proto.sample as SampleMethod;
  proto.sample = function sampleWithExtractableParks(this: AnyPlanning, x: number, z: number): PlanningSample {
    const sample = previousSample.call(this, x, z);
    if (sample.district !== DistrictType.Park) return sample;
    return {
      ...sample,
      // Parks are intentional open-space development: keep density low, but make sure the
      // road-bounded block extractor retains them even when the city's urban threshold is high.
      urbanScore: Math.max(sample.urbanScore, 0.96),
      density: Math.min(sample.density, 0.10),
    };
  };
  proto.__citySimParkExtractionV069 = true;
}
