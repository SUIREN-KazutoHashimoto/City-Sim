import { AgentStore } from './AgentStore';
import { clamp } from '../core/math';

/**
 * ニーズ減衰システム。
 * 全エージェントのニーズを時間経過で下げる。1日の位相で減衰率を変える等の拡張点。
 * 「意味的シミュレーション」の土台: ニーズの高低が UtilityBrain の目的選定を駆動する。
 *
 * 性能: これは単純な線形走査なので、数十万件でも安価。ただし毎フレームではなく
 *       低頻度(例: 1秒に1回)で回せば十分。SimulationLOD 側で更新間隔を決める。
 */
export class NeedSystem {
  /** 1シミュレーション秒あたりの基礎減衰率(0..1スケール) */
  private readonly decay = {
    energy: 1 / (16 * 3600), // 16時間で枯渇
    hunger: 1 / (6 * 3600),  // 6時間で空腹
    social: 1 / (10 * 3600),
    hygiene: 1 / (14 * 3600),
    fun: 1 / (8 * 3600),
  };

  /** dtSec 経過ぶんニーズを減衰。engagedState でのニーズ回復は別途 activity 側で行う。 */
  update(store: AgentStore, dtSec: number, begin = 0, end = store.count): void {
    const d = this.decay;
    for (let i = begin; i < end; i++) {
      store.energy[i]  = clamp(store.energy[i]  - d.energy  * dtSec, 0, 1);
      store.hunger[i]  = clamp(store.hunger[i]  - d.hunger  * dtSec, 0, 1);
      store.social[i]  = clamp(store.social[i]  - d.social  * dtSec, 0, 1);
      store.hygiene[i] = clamp(store.hygiene[i] - d.hygiene * dtSec, 0, 1);
      store.fun[i]     = clamp(store.fun[i]     - d.fun     * dtSec, 0, 1);
    }
  }
}
