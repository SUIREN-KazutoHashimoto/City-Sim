import * as THREE from 'three';
import { fleetDepotForNetwork, supplyChainForPoi } from '../generation/RuralIndustryAndDepotTuning';
import { generationFuelSnapshots } from '../power/GenerationFuelModel';
import { powerSystemForRoad } from '../power/PowerRuntimeRegistry';
import type { SidewalkNetwork } from '../traffic/SidewalkNetwork';
import { VehicleState } from '../traffic/VehicleStore';
import { POICategory } from '../world/POI';
import type { World } from '../world/World';
import {
  bad, clamp01, cool, muted, setMarker, severityColor, updateMesh, warn,
  type AccessKind, type ExpansionState, type OverlayInternals,
} from './CityDiagnosticOverlayExpansionCommon';

export function refreshLogisticsSupply(state:ExpansionState,world:World):void{
  const ui=state.manager as unknown as OverlayInternals; for(let i=0;i<ui.buildings.length;i++)ui.buildingMesh.setColorAt(i,muted);
  const chain=supplyChainForPoi(world.city.poi), scratch=new THREE.Color(); let siteBottlenecks=0,retailerShortages=0;
  if(chain){const stage:Record<string,THREE.Color>={farm:new THREE.Color(0x6faa4f),'raw-factory':new THREE.Color(0xb77943),processor:new THREE.Color(0x4b8cc9),assembler:new THREE.Color(0x8d69c8)};for(const site of chain.sites){if(site.buildingId<0||site.buildingId>=ui.buildings.length)continue;const inputShort=site.inputCapacity>0?1-clamp01(site.inputStock/site.inputCapacity):0,outputFull=site.outputCapacity>0?clamp01((site.outputStock/site.outputCapacity-0.72)/0.28):0,sev=Math.max(inputShort*0.82,outputFull);if(sev>0.55)siteBottlenecks++;ui.buildingMesh.setColorAt(site.buildingId,scratch.copy(stage[site.kind]??warn).lerp(bad,sev*0.72));}for(const id of chain.retailerPoiIds){const p=world.city.poi.get(id);if(p.buildingId<0||p.buildingId>=ui.buildings.length||p.maxStock<=0)continue;const sev=1-clamp01(p.stock/p.maxStock);if(sev>0.55)retailerShortages++;ui.buildingMesh.setColorAt(p.buildingId,severityColor(sev));}}
  updateMesh(ui.buildingMesh); let marker=0,fuelAlerts=0; const system=powerSystemForRoad(world.city.net);
  if(system){const fuels=new Map(generationFuelSnapshots(system).map(item=>[item.facilityId,item]));for(const facility of system.generationFacilities){const fuel=fuels.get(facility.id);if(!fuel)continue;const sev=1-clamp01(fuel.stockUnits/Math.max(1,fuel.capacityUnits));if(fuel.status!=='normal')fuelAlerts++;setMarker(state.markerMesh,marker++,facility.x,facility.z,7,7,fuel.status==='empty'||fuel.status==='critical'?bad:fuel.status==='reorder'?warn:severityColor(sev),0.7);}}
  const depot=fleetDepotForNetwork(world.city.net,'freight');if(depot)setMarker(state.markerMesh,marker++,depot.x,depot.z,6,4,new THREE.Color(0xc58b52));state.markerMesh.count=marker;updateMesh(state.markerMesh);
  const fuelTruckCount=(world.logistics as unknown as{fuelTruckCount?:number}).fuelTruckCount??0;ui.summary.textContent=`生産ボトルネック${siteBottlenecks} / 店舗在庫不足${retailerShortages} / 発電燃料警告${fuelAlerts} / 燃料トラック${fuelTruckCount}`;
}

export function refreshLogisticsFleet(state:ExpansionState,world:World):void{
  const ui=state.manager as unknown as OverlayInternals,edges=world.city.net.edges,edgeCount=new Uint16Array(edges.length),edgeSpeed=new Float32Array(edges.length),vs=world.vehicles;let trucks=0,stopped=0,marker=0;
  for(let v=0;v<vs.count;v++){if(!vs.isTruck[v])continue;trucks++;const driving=vs.state[v]===VehicleState.Driving,isStopped=driving&&vs.speed[v]<0.8;if(isStopped)stopped++;const edge=vs.edge[v];if(edge>=0&&edge<edgeCount.length){edgeCount[edge]++;edgeSpeed[edge]+=vs.speed[v];}setMarker(state.markerMesh,marker++,vs.posX[v],vs.posZ[v],2.6,2.4,isStopped?bad:driving?new THREE.Color(0x42c778):warn);}
  state.markerMesh.count=marker;updateMesh(state.markerMesh);for(const edge of edges){const count=edgeCount[edge.id];if(count<=0){ui.trafficMesh.setColorAt(edge.id,muted);continue;}const avg=edgeSpeed[edge.id]/count,speedPenalty=1-clamp01(avg/Math.max(1,edge.speedLimit)),density=clamp01(count/Math.max(1,edge.lanes*3));ui.trafficMesh.setColorAt(edge.id,severityColor(clamp01(density*0.58+speedPenalty*0.62)));}updateMesh(ui.trafficMesh);
  let cargo=0,capacity=0;for(let id=0;id<world.logistics.truckCount;id++){cargo+=world.logistics.truckCargo(id);capacity+=world.logistics.truckCapacity(id);}const logi=world.logistics as unknown as{fuelTruckCount?:number;fuelTruckCargo?:(id:number)=>number},system=powerSystemForRoad(world.city.net),fuelCount=logi.fuelTruckCount??0,fuelCap=system?.config.thermalFuelTruckCapacityUnits??0;for(let id=0;id<fuelCount;id++){cargo+=logi.fuelTruckCargo?.(id)??0;capacity+=fuelCap;}ui.summary.textContent=`物流車${trucks} / 停滞${stopped} / 積載率 ${capacity>0?(cargo/capacity*100).toFixed(1):'0.0'}% / 通常配送${world.logistics.truckCount} / 燃料配送${fuelCount}`;
}

function targetPositions(world:World,kind:AccessKind):Array<{x:number;z:number}>{
  if(kind==='station')return world.city.planning.rail.stations.map(s=>({x:s.x,z:s.z}));
  if(kind==='transit')return [...world.bus.stops.map(s=>({x:s.x,z:s.z})),...world.city.planning.rail.stations.map(s=>({x:s.x,z:s.z}))];
  const out:Array<{x:number;z:number}>=[],seen=new Set<number>();for(const p of world.city.poi.all()){if(p.capacity<=0)continue;const match=kind==='work'?p.category===POICategory.Work:kind==='commercial'?(p.category===POICategory.Food||p.category===POICategory.Retail||p.category===POICategory.Leisure):(p.category===POICategory.Health||p.category===POICategory.Education);if(!match)continue;out.push({x:p.x,z:p.z});if(p.buildingId>=0)seen.add(p.buildingId);}if(kind==='public')for(const f of world.city.facilities)if(!seen.has(f.buildingId))out.push({x:f.x,z:f.z});return out;
}
function multiSourceWalkTimes(graph:SidewalkNetwork,targets:readonly{x:number;z:number}[]):Float64Array{
  const dist=new Float64Array(graph.nodes.length);dist.fill(Infinity);const hn:number[]=[],hd:number[]=[];
  const push=(node:number,value:number)=>{let i=hn.length;hn.push(node);hd.push(value);while(i>0){const p=(i-1)>>1;if(hd[p]<=value)break;hn[i]=hn[p];hd[i]=hd[p];i=p;}hn[i]=node;hd[i]=value;};
  const pop=():{node:number;value:number}|null=>{if(!hn.length)return null;const node=hn[0],value=hd[0],lastN=hn.pop()!,lastD=hd.pop()!;if(hn.length){let i=0;for(;;){const l=i*2+1,r=l+1;if(l>=hn.length)break;const c=r<hn.length&&hd[r]<hd[l]?r:l;if(hd[c]>=lastD)break;hn[i]=hn[c];hd[i]=hd[c];i=c;}hn[i]=lastN;hd[i]=lastD;}return{node,value};};
  for(const target of targets){const node=graph.nearestNode(target.x,target.z);if(node<0||dist[node]===0)continue;dist[node]=0;push(node,0);}while(hn.length){const item=pop();if(!item)break;if(item.value!==dist[item.node])continue;for(const id of graph.nodes[item.node].edges){const e=graph.edges[id],next=item.value+e.length/1.4;if(next<dist[e.to]){dist[e.to]=next;push(e.to,next);}}}return dist;
}
export function accessibilityDistances(state:ExpansionState,world:World,kind:AccessKind):Float64Array{const cached=state.accessCache.get(kind);if(cached)return cached;const distances=multiSourceWalkTimes(world.sidewalk,targetPositions(world,kind));state.accessCache.set(kind,distances);return distances;}
function buildingNodes(state:ExpansionState,world:World):Int32Array{const ui=state.manager as unknown as OverlayInternals;if(state.buildingSidewalkNodes?.length===ui.buildings.length)return state.buildingSidewalkNodes;const nodes=new Int32Array(ui.buildings.length);nodes.fill(-1);for(let i=0;i<ui.buildings.length;i++)nodes[i]=world.sidewalk.nearestNode(ui.buildings[i].x,ui.buildings[i].z);state.buildingSidewalkNodes=nodes;return nodes;}
export function refreshAccessibility(state:ExpansionState,world:World,kind:Exclude<AccessKind,'transit'>,label:string):void{const ui=state.manager as unknown as OverlayInternals,dist=accessibilityDistances(state,world,kind),nodes=buildingNodes(state,world),samples:number[]=[];let within15=0,within30=0,reachable=0,max=0;for(let i=0;i<ui.buildings.length;i++){const sec=nodes[i]>=0?dist[nodes[i]]:Infinity;if(!Number.isFinite(sec)){ui.buildingMesh.setColorAt(i,muted);continue;}const min=sec/60;ui.buildingMesh.setColorAt(i,severityColor(clamp01((min-5)/25)));reachable++;if(min<=15)within15++;if(min<=30)within30++;max=Math.max(max,min);samples.push(min);}updateMesh(ui.buildingMesh);samples.sort((a,b)=>a-b);const median=samples.length?samples[Math.floor(samples.length*0.5)]:Infinity,p90=samples.length?samples[Math.min(samples.length-1,Math.floor(samples.length*0.9))]:Infinity;ui.summary.textContent=`${label}徒歩到達 / 15分以内 ${reachable?(within15/reachable*100).toFixed(1):'0.0'}% / 30分以内 ${reachable?(within30/reachable*100).toFixed(1):'0.0'}% / 中央値 ${Number.isFinite(median)?median.toFixed(1):'-'}分 / P90 ${Number.isFinite(p90)?p90.toFixed(1):'-'}分 / 最大 ${max.toFixed(1)}分`;}
