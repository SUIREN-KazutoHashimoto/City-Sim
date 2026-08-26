import type { AgentStore } from '../agents/AgentStore';
import type { ExternalVisitorPurpose, ExternalVisitorStationAccess } from './ExternalVisitorSystem';
import { latestExternalVisitorSystem } from './ExternalVisitorSystem';

export interface VisitorPresentationInfo {
  purpose: ExternalVisitorPurpose;
  remainingSeconds: number;
  returning: boolean;
  outboundQueued: boolean;
  onHighSpeedPlatform: boolean;
  platformY: number | null;
}

type VisitorRuntime = {
  store: AgentStore;
  world: { clock: { totalSeconds: number } };
  active: Uint8Array;
  purpose: Uint8Array;
  leaveAt: Float64Array;
  returning: Uint8Array;
  outboundQueued: Uint8Array;
  stationId: Int32Array;
  platformReleaseAt: Float64Array;
  platformDirection: Int8Array;
  highSpeedAccess: Map<string, ExternalVisitorStationAccess>;
};

function runtimeFor(store: AgentStore): VisitorRuntime | null {
  const system = latestExternalVisitorSystem();
  if (!system) return null;
  const runtime = system as unknown as VisitorRuntime;
  return runtime.store === store ? runtime : null;
}

function purposeFromCode(code: number): ExternalVisitorPurpose {
  if (code === 1) return 'shopping';
  if (code === 3) return 'hotel';
  return 'tourism';
}

export function visitorPresentationInfo(store: AgentStore, agent: number): VisitorPresentationInfo | null {
  const runtime = runtimeFor(store);
  if (!runtime || agent < 0 || agent >= store.count || runtime.active[agent] !== 1) return null;

  const now = runtime.world.clock.totalSeconds;
  const direction = runtime.platformDirection[agent];
  const station = runtime.stationId[agent];
  const access = (station >= 0 && (direction === 1 || direction === -1))
    ? runtime.highSpeedAccess.get(`${station}:${direction}`) ?? null
    : null;
  const onHighSpeedPlatform = runtime.platformReleaseAt[agent] > 0 || runtime.outboundQueued[agent] === 1;

  return {
    purpose: purposeFromCode(runtime.purpose[agent]),
    remainingSeconds: Math.max(0, runtime.leaveAt[agent] - now),
    returning: runtime.returning[agent] === 1,
    outboundQueued: runtime.outboundQueued[agent] === 1,
    onHighSpeedPlatform,
    platformY: onHighSpeedPlatform && access ? access.platformWait.y : null,
  };
}
