import { AgentStore } from './AgentStore';
import { clamp } from '../core/math';

/** ニーズ減衰。ニーズの高低が UtilityBrain の目的選定を駆動する。 */
export class NeedSystem {
  private readonly decay = {
    energy: 1 / (16 * 3600),
    hunger: 1 / (6 * 3600),
    social: 1 / (10 * 3600),
    hygiene: 1 / (14 * 3600),
    fun: 1 / (8 * 3600),
  };

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
