import type { World } from '../world/World';

// Begin well before the morning meal/work window so the initially-all-Idle population can settle
// into sleep/home states and wake up over time before the visible 08:00 start.
export const BOOT_START_SECONDS = 5 * 3600;
export const PLAY_START_SECONDS = 8 * 3600;
export const FAST_FORWARD_CHUNK_SECONDS = 60;

export interface PreRollProgress {
  progress: number;
  simulatedSeconds: number;
  batchSeconds: number;
  currentSeconds: number;
  batches: number;
}

export interface FastForwardResult {
  simulatedSeconds: number;
  batches: number;
}

/**
 * Advance the real World simulation without rendering. Each batch is capped at one simulated minute,
 * which keeps SimulationClock inside its existing 40-step / 1.5s adaptive-step limit. This is used
 * by both boot pre-roll and the runtime time-jump feature.
 */
export async function fastForwardWorld(
  world: World,
  requestedSeconds: number,
  onProgress?: (progress: PreRollProgress) => void,
): Promise<FastForwardResult> {
  const total = Number.isFinite(requestedSeconds) ? Math.max(0, requestedSeconds) : 0;
  if (total <= 0) return { simulatedSeconds: 0, batches: 0 };

  const start = world.clock.totalSeconds;
  const target = start + total;
  let batches = 0;

  while (world.clock.totalSeconds + 1e-6 < target) {
    const before = world.clock.totalSeconds;
    const remaining = target - before;
    const simChunk = Math.min(FAST_FORWARD_CHUNK_SECONDS, remaining);
    const scale = Math.max(1e-6, world.clock.timeScale);
    const steps = world.clock.advance(simChunk / scale);
    if (steps <= 0) throw new Error('renderless fast-forward could not advance SimulationClock');

    await world.stepBatchAsync(world.clock.stepDt, steps);
    batches++;

    const batchSeconds = Math.max(0, world.clock.totalSeconds - before);
    const simulatedSeconds = Math.min(total, Math.max(0, world.clock.totalSeconds - start));
    onProgress?.({
      progress: total > 0 ? simulatedSeconds / total : 1,
      simulatedSeconds,
      batchSeconds,
      currentSeconds: world.clock.totalSeconds,
      batches,
    });

    // Yield only so the loading/progress DOM can paint; WebGL rendering remains disabled by caller.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  return { simulatedSeconds: Math.max(0, world.clock.totalSeconds - start), batches };
}

/**
 * Advance the real simulation before the first visible frame so the city does not expose the
 * one-time all-Idle routing/A* burst or the synchronized morning transition to the player.
 */
export async function preRollWorld(
  world: World,
  onProgress?: (progress: PreRollProgress) => void,
): Promise<void> {
  const total = Math.max(0, PLAY_START_SECONDS - world.clock.totalSeconds);
  if (total <= 0) return;
  await fastForwardWorld(world, total, onProgress);
}
