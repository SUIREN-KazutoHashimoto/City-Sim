export type TimetableService = 'local' | 'rapid' | 'limited';

/**
 * 軽量な発車パターンダイヤ。
 *
 * ダイヤは列車の発車予定と運転整理だけを担当する。
 * 閉塞信号・ポイント開通・進路可否には一切関与しない。
 */
export class RailTimetable {
  static readonly CYCLE_SECONDS = 90;

  /**
   * 終端駅の次回発車スロット。
   * 同一路線では 特急→快速→普通 の順に発車時刻を散らす。
   * 複線幹線では上下方向を時間帯で排他しない。
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
    const directionOffset = direction > 0 ? 0 : 7;
    const serviceOffset = service === 'limited'
      ? 2
      : service === 'rapid'
        ? 20
        : 38 + (trainOrdinal % 2) * 16;
    const shifted = earliest + lineOffset;
    const cycleStart = Math.floor(shifted / cycle) * cycle;
    let target = cycleStart + directionOffset + serviceOffset - lineOffset;
    if (target < earliest - 1e-6) target += cycle;
    return target;
  }

  /** 発車・進路予約順のソートキー。小さいほど先。 */
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
    return scheduledDepartureAt
      - (isTerminal ? 72 : 0)
      - priority * 16
      - Math.min(120, late * 0.35 + waited * 0.55);
  }

  private lineOffset(lineId: number): number {
    // 共有駅へ複数路線が同時刻に集中しすぎないよう、路線単位で発車位相をずらす。
    return (Math.abs(lineId) * 13) % 24;
  }
}
