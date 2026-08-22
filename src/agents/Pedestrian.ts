import { GameObject } from '../world/GameObject';
import { AgentStore, AgentState } from './AgentStore';
export class Pedestrian extends GameObject {
  readonly kind = 'pedestrian';
  constructor(private store: AgentStore, readonly index: number) { super(); }
  override get x(): number { return this.store.posX[this.index]; }
  override get z(): number { return this.store.posZ[this.index]; }
  get speed(): number { const i = this.index; return Math.hypot(this.store.velX[i], this.store.velZ[i]); }
  get state(): AgentState { return this.store.state[this.index]; }
  override serialize(): Record<string, unknown> {
    const i = this.index;
    return { ...super.serialize(), state: AgentState[this.store.state[i]], goalPOI: this.store.goalPOI[i] };
  }
}
