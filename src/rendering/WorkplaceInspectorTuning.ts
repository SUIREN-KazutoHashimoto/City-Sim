import { BuildingArchetype } from '../generation/CityGenerator';
import { FACILITY_LABEL } from '../generation/SpecialFacilityPlanner';
import { productionSitesForNetwork } from '../generation/RuralIndustryAndDepotTuning';
import { POICategory } from '../world/POI';
import { aggregateWorkplaceStaffing, workplaceStaffingForPoi } from '../world/WorkplaceProductivityTuning';
import { UniversalInspector } from './UniversalInspector';

type AnyInspector = any;
type DescribeMethod = (this: AnyInspector, id: number) => string;

function productionLabel(kind: string): string {
  if (kind === 'farm') return '農地（農場）';
  if (kind === 'raw-factory') return '原料工場';
  if (kind === 'processor') return '加工工場';
  if (kind === 'assembler') return '組立工場';
  return '工場';
}

function workplaceLabel(world: any, buildingId: number): { label: string; production: boolean } {
  const building = world.city.buildings[buildingId] as Record<string, any> | undefined;
  if (!building) return { label: '職場', production: false };
  const site = productionSitesForNetwork(world.city.net).find((item: any) =>
    item.buildingId === buildingId || item.officeBuildingId === buildingId || item.warehouseBuildingId === buildingId);
  if (site) return { label: productionLabel(site.kind), production: true };

  const infrastructure = building.infrastructureLabel as string | undefined;
  if (infrastructure === 'taxi-depot') return { label: 'タクシー営業所', production: false };
  if (infrastructure === 'bus-depot') return { label: 'バス営業所', production: false };
  if (infrastructure === 'freight-depot') return { label: '物流営業所', production: false };
  if (infrastructure === 'farm-office' || infrastructure === 'farm-warehouse') return { label: '農地（農場）', production: true };

  const facility = world.city.facilities.find((item: any) => item.buildingId === buildingId);
  if (facility) return { label: FACILITY_LABEL[facility.type] ?? '公共施設', production: false };

  const intended = building.intendedUse as string | undefined;
  if (intended === 'restaurant') return { label: '飲食施設', production: false };
  if (intended === 'commercial') return { label: '商業施設', production: false };
  if (intended === 'hotel') return { label: 'ホテル', production: false };
  if (intended === 'office') return { label: 'オフィス', production: false };

  switch (building.archetype) {
    case BuildingArchetype.Factory: return { label: '工場', production: true };
    case BuildingArchetype.Warehouse: return { label: '倉庫・物流施設', production: false };
    case BuildingArchetype.SmallOffice:
    case BuildingArchetype.OfficeSlab:
    case BuildingArchetype.OfficeTower: return { label: 'オフィス', production: false };
    case BuildingArchetype.SmallShop:
    case BuildingArchetype.RetailBox:
    case BuildingArchetype.CommercialBlock: return { label: '商業施設', production: false };
    case BuildingArchetype.MixedUse: return { label: '複合商業・業務施設', production: false };
    default: return { label: POICategory[building.category] === 'Work' ? '職場' : (POICategory[building.category] ?? '職場'), production: false };
  }
}

const proto = UniversalInspector.prototype as unknown as Record<string, any>;
if (!proto.__citySimWorkplaceInspectorV077) {
  const previousDescribeAgent = proto.describeAgent as DescribeMethod;
  proto.describeAgent = function describeAgentWithWorkplace(this: AnyInspector, agent: number): string {
    const text = previousDescribeAgent.call(this, agent);
    if (!text) return text;
    const store = this.world.store;
    const workPoiId = store.workPOI[agent];
    if (workPoiId < 0) return `${text}\n勤務先 なし`;
    const poi = this.world.city.poi.get(workPoiId);
    if (!poi) return `${text}\n勤務先 不明`;
    const info = workplaceLabel(this.world, poi.buildingId);
    const staffing = workplaceStaffingForPoi(this.world.city.poi, workPoiId);
    return `${text}\n勤務先 ${info.label} / 建物 #${poi.buildingId}\n出勤 ${staffing.present}/${staffing.capacity} / ${info.production ? '生産' : '稼働'}効率 ${Math.round(staffing.efficiency * 100)}%`;
  };

  const previousDescribeBuilding = proto.describeBuilding as DescribeMethod;
  proto.describeBuilding = function describeBuildingWithWorkplace(this: AnyInspector, buildingId: number): string {
    const text = previousDescribeBuilding.call(this, buildingId);
    if (!text) return text;
    const workPois = this.world.city.poi.poisInBuilding(buildingId).filter((p: any) => p.category === POICategory.Work && p.capacity > 0);
    if (workPois.length === 0) return text;
    const info = workplaceLabel(this.world, buildingId);
    const staffing = aggregateWorkplaceStaffing(this.world.city.poi, workPois.map((p: any) => p.id));
    return `${text}\n職場種別 ${info.label}\n出勤 ${staffing.present}/${staffing.capacity} / ${info.production ? '生産' : '稼働'}効率 ${Math.round(staffing.efficiency * 100)}%`;
  };

  proto.__citySimWorkplaceInspectorV077 = true;
}
