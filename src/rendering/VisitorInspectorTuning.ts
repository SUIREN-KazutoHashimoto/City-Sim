import { visitorPresentationInfo } from '../world/VisitorPresentation';
import { UniversalInspector } from './UniversalInspector';

type AnyInspector = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const PURPOSE_LABEL = {
  shopping: '買い物',
  tourism: '観光',
  hotel: '宿泊',
} as const;

function formatRemaining(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return `${days}日${rest}時間`;
  }
  if (hours > 0) return `${hours}時間${minutes}分`;
  return `${minutes}分`;
}

const proto = UniversalInspector.prototype as unknown as Record<string, any>;
if (!proto.__citySimVisitorInspectorV066) {
  const previousDescribe = proto.describeAgent as AnyMethod;
  proto.describeAgent = function describeAgentWithVisitorInfo(this: AnyInspector, agent: number): string {
    const base = previousDescribe.call(this, agent) as string;
    if (!base) return base;
    const info = visitorPresentationInfo(this.world.store, agent);
    if (!info) return base;

    const lines = base.split('\n');
    if (lines.length > 0) lines[0] = lines[0].replace(/^市民\s+/, '来訪者 ');
    const status = info.outboundQueued
      ? '新幹線待ち'
      : info.onHighSpeedPlatform
        ? '新幹線ホーム滞在中'
        : info.returning
          ? '駅へ帰還中'
          : '市内滞在中';
    lines.splice(1, 0,
      `種別 来訪者 / 目的 ${PURPOSE_LABEL[info.purpose]}`,
      `滞在残り ${formatRemaining(info.remainingSeconds)} / 帰還中 ${info.returning ? 'はい' : 'いいえ'} / ${status}`,
    );
    return lines.join('\n');
  };

  const previousPinned = proto.updatePinnedStatus as AnyMethod;
  proto.updatePinnedStatus = function updatePinnedStatusWithVisitorLabel(this: AnyInspector): void {
    previousPinned.call(this);
    if (this.followKind !== 'agent' || this.followId < 0) return;
    const info = visitorPresentationInfo(this.world.store, this.followId);
    if (!info || !this.pinEl?.textContent) return;
    this.pinEl.textContent = this.pinEl.textContent.replace(/^追跡: 市民/, '追跡: 来訪者');
  };

  proto.__citySimVisitorInspectorV066 = true;
}
