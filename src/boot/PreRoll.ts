import type { World } from '../world/World';

export const BOOT_START_SECONDS = 7.5 * 3600;
export const PLAY_START_SECONDS = 8 * 3600;
const PRE_ROLL_CHUNK_SECONDS = 30;

export interface PreRollProgress {
  progress: number;
  simulatedSeconds: number;
  currentSeconds: number;
  batches: number;
}

/**
 * Advance the real simulation before the first visible frame so the city does not expose the
 * one-time all-Idle routing/A* burst to the player. This uses the normal World batch pipeline and
 * stays within SimulationClock's supported adaptive-step range; it does not accumulate wall-time
 * debt because the runtime scheduler has not started yet.
 */
export async function preRollWorld(
  world: World,
  onProgress?: (progress: PreRollProgress) => void,
): Promise<void> {
  const start = world.clock.totalSeconds;
  const total = Math.max(0, PLAY_START_SECONDS - start);
  if (total <= 0) return;

  let batches = 0;
  while (world.clock.totalSeconds + 1e-6 < PLAY_START_SECONDS) {
    const remaining = PLAY_START_SECONDS - world.clock.totalSeconds;
    const simChunk = Math.min(PRE_ROLL_CHUNK_SECONDS, remaining);
    const scale = Math.max(1, world.clock.timeScale);
    const steps = world.clock.advance(simChunk / scale);
    if (steps <= 0) throw new Error('bootstrap pre-roll could not advance SimulationClock');

    await world.stepBatchAsync(world.clock.stepDt, steps);
    batches++;

    const simulatedSeconds = Math.min(total, world.clock.totalSeconds - start);
    onProgress?.({
      progress: total > 0 ? simulatedSeconds / total : 1,
      simulatedSeconds,
      currentSeconds: world.clock.totalSeconds,
      batches,
    });

    // Let the DOM paint the loading progress between expensive simulation batches.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
}
