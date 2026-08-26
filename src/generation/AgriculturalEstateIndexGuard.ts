import { CityGenerator } from './CityGenerator';

type AnyCity = CityGenerator & Record<string, any>;
type GenerateMethod = (this: AnyCity, ...args: any[]) => any;

const NEGATIVE_KEYS = [-1, -2, -3, -4, -5] as const;
const ACCESS_SIDES = new Set(['west', 'east', 'north', 'south']);

function isFarmShapeTable(value: unknown[]): boolean {
  return value.length === 5
    && value.every((item) => Array.isArray(item) && item.length === 2
      && Number.isFinite(item[0]) && Number.isFinite(item[1]));
}

function isFarmAccessSideList(value: unknown[]): boolean {
  return value.length > 0 && value.length <= 4
    && value.every((item) => typeof item === 'string' && ACCESS_SIDES.has(item));
}

function installNegativeFarmIndexGuard(): () => void {
  const saved: Array<{ key: string; descriptor: PropertyDescriptor | undefined }> = [];

  for (const negative of NEGATIVE_KEYS) {
    const key = String(negative);
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
    saved.push({ key, descriptor });
    if (descriptor) continue;

    Object.defineProperty(Array.prototype, key, {
      configurable: true,
      get(this: unknown[]): unknown {
        if (!Array.isArray(this) || this.length === 0) return undefined;
        if (!isFarmShapeTable(this) && !isFarmAccessSideList(this)) return undefined;
        const index = ((negative % this.length) + this.length) % this.length;
        return this[index];
      },
    });
  }

  return () => {
    for (const { key, descriptor } of saved) {
      if (descriptor) Object.defineProperty(Array.prototype, key, descriptor);
      else delete (Array.prototype as unknown as Record<string, unknown>)[key];
    }
  };
}

const proto = CityGenerator.prototype as unknown as Record<string, any>;
if (!proto.__citySimAgriculturalEstateSignedIndexGuardV080) {
  const previousGenerate = proto.generate as GenerateMethod;
  proto.generate = function generateWithUnsignedFarmIndexes(this: AnyCity, ...args: any[]): any {
    // AgriculturalEstateTuning v0.1.77's hash01 ends with a signed 32-bit xor. Negative hash values
    // therefore become negative array indexes when selecting farm shapes/access sides. Wrapping a
    // negative index modulo the array length is exactly equivalent to the intended unsigned hash
    // result (signed / 2^32 + 1) for these lookups. Keep the compatibility guard scoped strictly to
    // synchronous city generation and only to the two agricultural selector-array shapes.
    const restore = installNegativeFarmIndexGuard();
    try { return previousGenerate.apply(this, args); }
    finally { restore(); }
  };
  proto.__citySimAgriculturalEstateSignedIndexGuardV080 = true;
}
