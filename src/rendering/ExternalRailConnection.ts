import type { RailRenderer } from './RailRenderer';
import { installExternalRailConnection as installStraightExternalRailConnection } from './StraightRoadExternalRailConnection';
import { latestHighSpeedRailInspectionSource } from './HighSpeedRailRegistry';

interface MutableHighSpeedPointSource {
  __citySimLeftHandTrackV022?: boolean;
  pointAt?: (s: number, offset?: number) => { x: number; z: number };
}

interface HighSpeedInspectionAdapterInternal {
  source?: MutableHighSpeedPointSource;
}

/**
 * Keep the dedicated high-speed line on the Japanese left-hand track.
 *
 * StraightRoadHighSpeedRail uses a lateral basis that points to the physical right side in the X-Z
 * ground plane. The inspection adapter keeps a reference to the underlying system, so after install
 * we invert that system's pointAt offset once. Infrastructure is symmetric; all live train bodies,
 * status snapshots, hit boxes and pointed noses then use the corrected left-hand position.
 */
export function installExternalRailConnection(renderer: RailRenderer): void {
  installStraightExternalRailConnection(renderer);

  const inspection = latestHighSpeedRailInspectionSource();
  const adapter = inspection as unknown as HighSpeedInspectionAdapterInternal;
  const source = adapter?.source;
  if (!source || source.__citySimLeftHandTrackV022 || typeof source.pointAt !== 'function') return;

  const basePointAt = source.pointAt.bind(source);
  source.pointAt = (s: number, offset = 0) => basePointAt(s, -offset);
  source.__citySimLeftHandTrackV022 = true;
}
