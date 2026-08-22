export type EntityId = number;
export interface ISimulated {
  readonly id: EntityId; readonly x: number; readonly z: number;
  serialize(): Record<string, unknown>;
}
export abstract class GameObject implements ISimulated {
  private static _next: EntityId = 1;
  readonly id: EntityId;
  abstract readonly kind: string;
  enabled = true;
  constructor(id?: EntityId) { this.id = id ?? GameObject._next++; }
  abstract get x(): number;
  abstract get z(): number;
  position(): { x: number; z: number } { return { x: this.x, z: this.z }; }
  serialize(): Record<string, unknown> {
    return { id: this.id, kind: this.kind, x: this.x, z: this.z, enabled: this.enabled };
  }
}
