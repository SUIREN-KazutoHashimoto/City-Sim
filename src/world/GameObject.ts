/**
 * ============================================================================
 *  OOP ドメイン層(ファサード)
 * ============================================================================
 * 要件である「大量の属性・一貫したメソッド・継承・カプセル化・汎用インターフェース」
 * を担う層。ただし *毎フレームここでロジックを回すわけではない*。
 *
 * 設計の要点:
 *  - ホットループ(移動積分・近接回避・経路追従)は AgentStore の SoA(TypedArray)
 *    で処理する。GameObject は「そのストアの1行への型付きハンドル/ビュー」に徹する。
 *  - これにより「拡張しやすいOOPの表現力」と「キャッシュ効率の良い実行性能」を両立する。
 *    (= Entity は薄いハンドル、Component データは配列、System がまとめて更新する)
 */

export type EntityId = number;

/** 全シミュレーション対象が実装する最小インターフェース。 */
export interface ISimulated {
  readonly id: EntityId;
  /** ワールド座標(地表2D) */
  readonly x: number;
  readonly z: number;
  /** シリアライズ用のプレーンな属性辞書を返す(セーブ/デバッグ/ネットワーク同期に使う) */
  serialize(): Record<string, unknown>;
}

/** カメラや他システムから位置を問い合わせできるもの。 */
export interface ILocatable {
  position(): { x: number; z: number };
}

/**
 * 全オブジェクトの共通基底。ID・種別・有効フラグなど「どのオブジェクトも持つ」属性を集約。
 * 具体的な数値データ(座標・速度・ニーズ)は派生と対応する Store が持つ。
 */
export abstract class GameObject implements ISimulated, ILocatable {
  private static _next: EntityId = 1;
  readonly id: EntityId;
  /** 継承ツリーを実行時に識別するためのタグ('pedestrian' | 'vehicle' | 'building' ...) */
  abstract readonly kind: string;
  enabled = true;

  constructor(id?: EntityId) {
    this.id = id ?? GameObject._next++;
  }

  abstract get x(): number;
  abstract get z(): number;

  position(): { x: number; z: number } { return { x: this.x, z: this.z }; }

  /** 派生でオーバーライドして固有属性を足す。基底は共通属性のみ出力。 */
  serialize(): Record<string, unknown> {
    return { id: this.id, kind: this.kind, x: this.x, z: this.z, enabled: this.enabled };
  }
}
