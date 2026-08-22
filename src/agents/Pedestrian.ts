import { GameObject } from '../world/GameObject';
import { AgentStore, AgentState } from './AgentStore';

/**
 * OOPファサードの具体例。
 * Pedestrian は AgentStore の1行(index)への型付きハンドル。
 * データは配列側にあるため、このオブジェクトは大量生成しない(選択中/検査対象のみ包む)。
 *
 * これにより「OOPで属性とメソッドを一貫して触れるAPI」と
 * 「SoAによる高速な一括更新」を同時に満たす。
 * Vehicle など他の派生も同じ Store もしくは専用 Store のハンドルとして実装する。
 */
export class Pedestrian extends GameObject {
  readonly kind = 'pedestrian';

  constructor(private store: AgentStore, readonly index: number) {
    super();
  }

  override get x(): number { return this.store.posX[this.index]; }
  override get z(): number { return this.store.posZ[this.index]; }

  get speed(): number {
    const i = this.index;
    return Math.hypot(this.store.velX[i], this.store.velZ[i]);
  }
  get state(): AgentState { return this.store.state[this.index]; }
  get energy(): number { return this.store.energy[this.index]; }
  get hunger(): number { return this.store.hunger[this.index]; }

  override serialize(): Record<string, unknown> {
    const i = this.index;
    return {
      ...super.serialize(),
      state: AgentState[this.store.state[i]],
      needs: {
        energy: this.store.energy[i], hunger: this.store.hunger[i],
        social: this.store.social[i], fun: this.store.fun[i],
      },
      goalPOI: this.store.goalPOI[i],
    };
  }
}
