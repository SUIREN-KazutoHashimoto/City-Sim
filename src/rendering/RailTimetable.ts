export type TimetableService = 'local' | 'rapid' | 'limited';

/**
 * 軽量なパターンダイヤ。
 *
 * 単線・共有線区で上下列車を同時に押し込まず、一定時間ごとに方向を切り替える。
 * 終端では同一方向窓の中を 特急→快速→普通 の順で発車させる。
 */
export class RailTimetable {
  static readonly CYCLE_SECONDS = 120;
  static readonly DIRECTION_WINDOW_SECONDS = 50;
  static readonly OPPOSITE_START_SECONDS = 60;
  static readonly MAX_STARVATION_SECONDS = 150;

  directionWindowOpen(time: number, lineId: number, direction: 1 | -1): boolean {
    const phase = this.phase(time, lineId);
    if (direction > 0) return phase >= 0 && phase < RailTimetable.DIRECTION_WINDOW_SECONDS;
    return phase >= RailTimetable.OPPOSITE_START_SECONDS
      && phase < RailTimetable.OPPOSITE_START_SECONDS + RailTimetable.DIRECTION_WINDOW_SECONDS;
  }

  /** 次にその方向の運転窓が始まる時刻。 */
  nextDirectionWindow(time: number, lineId: number, direction: 1 | -1): number {
    const cycle = RailTimetable.CYCLE_SECONDS;
    const lineOffset = this.lineOffset(lineId);
    const base = direction > 0 ? 0 : RailTimetable.OPPOSITE_START_SECONDS;
    const shifted = time + lineOffset;
    const cycleStart = Math.floor(shifted / cycle) * cycle;
    let target = cycleStart + base - lineOffset;
    if (target < time - 1e-6) target += cycle;
    return target;
  }

  /**
   * 終端駅の発車スロット。
   * trainOrdinalで同種別が複数いても少しずつ間隔を空ける。
   */
  nextTerminalDeparture(
    earliest: number,
    lineId: number,
    direction: 1 | -1,
    service: TimetableService,
    trainOrdinal: number,
  ): number {
    const cycle = RailTimetable.CYCLE_SECONDS;
    const lineOffset = this.lineOffset(lineId);
    const base = direction > 0 ? 0 : RailTimetable.OPPOSITE_START_SECONDS;
    const serviceOffset = service === 'limited' ? 3 : service === 'rapid' ? 14 : 26 + (trainOrdinal % 2) * 12;
    const shifted = earliest + lineOffset;
    const cycleStart = Math.floor(shifted / cycle) * cycle;
    let target = cycleStart + base + serviceOffset - lineOffset;
    if (target < earliest - 1e-6) target += cycle;
    return target;
  }

  /** 発車順ソート用。小さいほど先。 */
  dispatchKey(
    scheduledDepartureAt: number,
    waitingSince: number,
    service: TimetableService,
    isTerminal: boolean,
    now: number,
  ): number {
    const priority = service === 'limited' ? 3 : service === 'rapid' ? 2 : 1;
    const late = Math.max(0, now - scheduledDepartureAt);
    const waited = waitingSince >= 0 ? Math.max(0, now - waitingSince) : 0;
    // 終端から出す列車を強く優先し、長時間待ちは種別差を徐々に打ち消す。
    return scheduledDepartureAt
      - (isTerminal ? 80 : 0)
      - priority * 16
      - Math.min(90, late * 0.35 + waited * 0.45);
  }

  starved(now: number, waitingSince: number): boolean {
    return waitingSince >= 0 && now - waitingSince >= RailTimetable.MAX_STARVATION_SECONDS;
  }

  private phase(time: number, lineId: number): number {
    const cycle = RailTimetable.CYCLE_SECONDS;
    const raw = (time + this.lineOffset(lineId)) % cycle;
    return raw < 0 ? raw + cycle : raw;
  }

  private lineOffset(lineId: number): number {
    // 共有駅へ全路線が同時刻に殺到しないよう路線ごとに位相をずらす。
    return (Math.abs(lineId) * 17) % 24;
  }
}
