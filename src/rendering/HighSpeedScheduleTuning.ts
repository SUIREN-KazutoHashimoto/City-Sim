import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

type Direction = 1 | -1;
type HighSpeedState = 'running' | 'dwell';

interface HighSpeedTrainRuntime {
  id: number;
  direction: Direction;
  state: HighSpeedState;
  dwellUntil: number;
}

interface HighSpeedSource {
  __citySimScheduleV027?: boolean;
  trains?: HighSpeedTrainRuntime[];
  lastTime?: number;
  nextDown?: number;
  nextUp?: number;
  stepTrain?: (train: HighSpeedTrainRuntime, dt: number, now: number) => boolean;
  advanceInterval?: (dt: number, startTime: number) => void;
  advanceTo?: (now: number) => void;
  spawn?: (direction: Direction, now: number) => void;
  visitorSystem?: { advanceTo?: (now: number) => void } | null;
  updatePanel?: (force: boolean) => void;
  panel?: HTMLDivElement | null;
}

interface AdapterInternal { source?: HighSpeedSource; }

const HSR_DWELL_SECONDS = 6 * 60;
const HSR_HEADWAY_SECONDS = 9 * 60;
const HSR_UP_PHASE_SECONDS = HSR_HEADWAY_SECONDS * 0.5;

function nextSlot(after: number, phase: number): number {
  return phase + (Math.floor((after - phase) / HSR_HEADWAY_SECONDS) + 1) * HSR_HEADWAY_SECONDS;
}

/**
 * Keep the previous rule that the next same-direction train reaches Central three minutes after the
 * preceding departure. With a six-minute dwell that means a nine-minute same-direction arrival cycle.
 */
export function installHighSpeedScheduleTuning(): void {
  const inspection = latestHighSpeedRailInspectionSource();
  const source = (inspection as unknown as AdapterInternal | null)?.source;
  if (!source || source.__citySimScheduleV027) return;
  source.__citySimScheduleV027 = true;

  const baseStepTrain = source.stepTrain?.bind(source);
  if (baseStepTrain) {
    source.stepTrain = (train, dt, now) => {
      const before = train.state;
      const removed = baseStepTrain(train, dt, now);
      if (before !== 'dwell' && train.state === 'dwell') train.dwellUntil = now + HSR_DWELL_SECONDS;
      return removed;
    };
  }

  const advanceInterval = source.advanceInterval?.bind(source);
  if (advanceInterval && source.spawn && typeof source.lastTime === 'number') {
    source.nextDown = nextSlot(source.lastTime - 1e-6, 0);
    source.nextUp = nextSlot(source.lastTime - 1e-6, HSR_UP_PHASE_SECONDS);

    source.advanceTo = (now) => {
      if (!Number.isFinite(now) || typeof source.lastTime !== 'number' || now <= source.lastTime + 1e-7) return;
      if (typeof source.nextDown !== 'number') source.nextDown = nextSlot(source.lastTime - 1e-6, 0);
      if (typeof source.nextUp !== 'number') source.nextUp = nextSlot(source.lastTime - 1e-6, HSR_UP_PHASE_SECONDS);

      while (Math.min(source.nextDown, source.nextUp) <= now + 1e-7) {
        const event = Math.min(source.nextDown, source.nextUp);
        advanceInterval(event - source.lastTime, source.lastTime);
        source.lastTime = event;
        if (source.nextDown <= event + 1e-7) {
          source.spawn?.(1, event);
          source.nextDown += HSR_HEADWAY_SECONDS;
        }
        if (source.nextUp <= event + 1e-7) {
          source.spawn?.(-1, event);
          source.nextUp += HSR_HEADWAY_SECONDS;
        }
      }

      advanceInterval(now - source.lastTime, source.lastTime);
      source.lastTime = now;
      source.visitorSystem?.advanceTo?.(now);
      source.updatePanel?.(false);
    };
  }

  const baseUpdatePanel = source.updatePanel?.bind(source);
  if (baseUpdatePanel) {
    source.updatePanel = (force) => {
      baseUpdatePanel(force);
      if (!source.panel?.textContent) return;
      source.panel.textContent = source.panel.textContent
        .replace('中央駅 12分停車 / 同方向15分間隔 / 発車3分後に次列車', '中央駅 6分停車 / 同方向9分間隔 / 発車3分後に次列車')
        .replace('中央駅 12分停車', '中央駅 6分停車')
        .replace('同方向15分間隔', '同方向9分間隔');
    };
  }

  source.updatePanel?.(true);
}
