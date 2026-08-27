import { Occupation } from '../agents/AgentStore';
import { lifelineWorkplaceForPoi, isLifelineWorkplace } from './LifelineWorkforce';
import { POICategory } from './POI';
import { World } from './World';

type AnyWorld = Record<string, any>;
type AnyMethod = (...args: any[]) => any;

const MIN_STAFFING_RATIO = 0.50;
const NATURAL_WORKER_SHARE = 0.63;
const VISITOR_HEADROOM = 7000;

function isWorkerOccupation(value: number): boolean {
  return value === Occupation.Office
    || value === Occupation.ShiftEarly
    || value === Occupation.ShiftLate
    || value === Occupation.NightShift
    || value === Occupation.Retail
    || value === Occupation.Freelance;
}

function scheduleFor(serial: number): { occupation: Occupation; start: number; end: number } {
  switch (serial % 6) {
    case 1: return { occupation: Occupation.ShiftEarly, start: 6, end: 14 };
    case 2: return { occupation: Occupation.ShiftLate, start: 14, end: 22 };
    case 3: return { occupation: Occupation.NightShift, start: 22, end: 6 };
    case 4: return { occupation: Occupation.Retail, start: 10, end: 20 };
    case 5: return { occupation: Occupation.Freelance, start: 10, end: 16 };
    default: return { occupation: Occupation.Office, start: 9, end: 18 };
  }
}

function lifelineSchedule(serial: number): { occupation: Occupation; start: number; end: number } {
  switch (serial % 3) {
    case 1: return { occupation: Occupation.ShiftLate, start: 14, end: 22 };
    case 2: return { occupation: Occupation.NightShift, start: 22, end: 6 };
    default: return { occupation: Occupation.ShiftEarly, start: 6, end: 14 };
  }
}

function staffingTargets(world: AnyWorld): { targets: Int32Array; required: number; workplaceCount: number; lifelineRequired: number; lifelineCount: number } {
  const poi = world.city.poi;
  const targets = new Int32Array(poi.size);
  let required = 0;
  let workplaceCount = 0;
  let lifelineRequired = 0;
  let lifelineCount = 0;
  for (const p of poi.all()) {
    if (p.category !== POICategory.Work || p.capacity <= 0) continue;
    const lifeline = lifelineWorkplaceForPoi(poi, p.id);
    const target = lifeline
      ? Math.max(1, Math.min(p.capacity, lifeline.rosterTarget))
      : Math.max(1, Math.ceil(p.capacity * MIN_STAFFING_RATIO));
    targets[p.id] = target;
    required += target;
    workplaceCount++;
    if (lifeline) { lifelineRequired += target; lifelineCount++; }
  }
  return { targets, required, workplaceCount, lifelineRequired, lifelineCount };
}

function applyLifelineSchedules(world: AnyWorld): void {
  const store = world.store;
  const poi = world.city.poi;
  const workers = new Map<number, number[]>();
  for (let agent = 0; agent < store.count; agent++) {
    const work = store.workPOI[agent];
    if (work < 0 || !isLifelineWorkplace(poi, work) || !isWorkerOccupation(store.occupation[agent])) continue;
    let list = workers.get(work);
    if (!list) { list = []; workers.set(work, list); }
    list.push(agent);
  }
  for (const [work, agents] of workers) {
    agents.sort((a, b) => a - b);
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const schedule = lifelineSchedule(i);
      store.occupation[agent] = schedule.occupation;
      store.workStart[agent] = schedule.start;
      store.workEnd[agent] = schedule.end;
      store.nextDecideAt[agent] = 0;
    }
    const spec = lifelineWorkplaceForPoi(poi, work);
    if (spec && agents.length < spec.rosterTarget) {
      console.warn('[City-Sim] lifeline workplace roster below target', {
        key: spec.key,
        assigned: agents.length,
        target: spec.rosterTarget,
      });
    }
  }
}

function rebalanceAssignments(world: AnyWorld, targets: Int32Array): { assigned: number; shortfall: number; spawned: number; lifelineShortfall: number } {
  const store = world.store;
  const poi = world.city.poi;
  const counts = new Int32Array(poi.size);
  const spare: number[] = [];

  for (let agent = 0; agent < store.count; agent++) {
    if (!isWorkerOccupation(store.occupation[agent])) {
      store.workPOI[agent] = -1;
      continue;
    }
    const work = store.workPOI[agent];
    if (work >= 0 && work < counts.length && targets[work] > 0) counts[work]++;
    else {
      store.workPOI[agent] = -1;
      spare.push(agent);
    }
  }

  for (let agent = 0; agent < store.count; agent++) {
    if (!isWorkerOccupation(store.occupation[agent])) continue;
    const work = store.workPOI[agent];
    if (work < 0 || work >= counts.length || targets[work] <= 0) continue;
    if (counts[work] <= targets[work]) continue;
    counts[work]--;
    store.workPOI[agent] = -1;
    spare.push(agent);
  }

  const deficits: number[] = [];
  for (let work = 0; work < targets.length; work++) if (targets[work] > counts[work]) deficits.push(work);
  deficits.sort((a, b) => {
    const aLife = isLifelineWorkplace(poi, a) ? 0 : 1;
    const bLife = isLifelineWorkplace(poi, b) ? 0 : 1;
    if (aLife !== bLife) return aLife - bLife;
    const aPriority = lifelineWorkplaceForPoi(poi, a)?.priority ?? 100;
    const bPriority = lifelineWorkplaceForPoi(poi, b)?.priority ?? 100;
    return aPriority - bPriority || (targets[b] - counts[b]) - (targets[a] - counts[a]);
  });

  for (const work of deficits) {
    while (counts[work] < targets[work] && spare.length) {
      const agent = spare.pop()!;
      store.workPOI[agent] = work;
      counts[work]++;
    }
  }

  const homes = poi.all().filter((p: any) => p.category === POICategory.Home && p.capacity > 0);
  const homeAssigned = new Int32Array(poi.size);
  for (let agent = 0; agent < store.count; agent++) {
    const home = store.homePOI[agent];
    if (home >= 0 && home < homeAssigned.length) homeAssigned[home]++;
  }

  let spawned = 0;
  let serial = 0;
  const takeHome = (workId: number): number => {
    if (!homes.length) return -1;
    const work = poi.get(workId);
    const start = Math.abs(Math.imul(workId + 1, 1103515245)) % homes.length;
    let best = -1;
    let bestD2 = Infinity;
    const probes = Math.min(homes.length, isLifelineWorkplace(poi, workId) ? 640 : 320);
    for (let k = 0; k < probes; k++) {
      const home = homes[(start + k * 37) % homes.length];
      if (homeAssigned[home.id] >= home.capacity) continue;
      const d2 = (home.x - work.x) ** 2 + (home.z - work.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = home.id; }
    }
    if (best >= 0) return best;
    for (const home of homes) if (homeAssigned[home.id] < home.capacity) return home.id;
    return -1;
  };

  for (const work of deficits) {
    while (counts[work] < targets[work] && store.count < store.capacity) {
      const homeId = takeHome(work);
      if (homeId < 0) break;
      const home = poi.get(homeId);
      const jitterSeed = Math.imul(work + 17, 7919) ^ Math.imul(serial + 31, 3571);
      const jx = (((jitterSeed >>> 3) & 255) / 255 - 0.5) * 8;
      const jz = (((jitterSeed >>> 12) & 255) / 255 - 0.5) * 8;
      const agent = store.spawn(home.x + jx, home.z + jz);
      if (agent < 0) break;
      const schedule = isLifelineWorkplace(poi, work) ? lifelineSchedule(counts[work]) : scheduleFor(serial++);
      store.homePOI[agent] = homeId;
      store.workPOI[agent] = work;
      store.occupation[agent] = schedule.occupation;
      store.workStart[agent] = schedule.start;
      store.workEnd[agent] = schedule.end;
      store.ownsCar[agent] = 0;
      store.car[agent] = -1;
      store.nextDecideAt[agent] = 0;
      homeAssigned[homeId]++;
      counts[work]++;
      spawned++;
    }
  }

  applyLifelineSchedules(world);

  let assigned = 0;
  let shortfall = 0;
  let lifelineShortfall = 0;
  for (let work = 0; work < targets.length; work++) {
    if (targets[work] <= 0) continue;
    assigned += counts[work];
    const missing = Math.max(0, targets[work] - counts[work]);
    shortfall += missing;
    if (isLifelineWorkplace(poi, work)) lifelineShortfall += missing;
  }
  return { assigned, shortfall, spawned, lifelineShortfall };
}

const proto = World.prototype as unknown as AnyWorld;
if (!proto.__citySimWorkforceCoverageV1015) {
  const previousPopulate = proto.populate as AnyMethod;
  proto.populate = function populateWithWorkforceCoverage(this: AnyWorld, requestedPopulation: number): void {
    const plan = staffingTargets(this);
    const residentLimitWithVisitors = Math.max(0, this.store.capacity - VISITOR_HEADROOM);
    const estimatedPopulation = Math.ceil(plan.required / NATURAL_WORKER_SHARE);
    const targetPopulation = Math.min(
      this.store.capacity,
      Math.max(requestedPopulation, Math.min(residentLimitWithVisitors, estimatedPopulation)),
    );

    previousPopulate.call(this, targetPopulation);
    const result = rebalanceAssignments(this, plan.targets);
    const coverage = plan.required > 0 ? (plan.required - result.shortfall) / plan.required : 1;
    console.info('[City-Sim] workforce coverage', {
      requestedPopulation,
      targetPopulation,
      actualPopulation: this.store.count,
      workplaces: plan.workplaceCount,
      halfCapacityTarget: plan.required - plan.lifelineRequired,
      lifelineWorkplaces: plan.lifelineCount,
      lifelineRosterTarget: plan.lifelineRequired,
      assignedWorkers: result.assigned,
      spawnedForCoverage: result.spawned,
      coverage,
      shortfall: result.shortfall,
      lifelineShortfall: result.lifelineShortfall,
    });
    if (result.lifelineShortfall > 0) {
      console.warn('[City-Sim] critical lifeline workforce guarantee reached an agent/home capacity limit', result);
    } else if (result.shortfall > 0) {
      console.warn('[City-Sim] workforce half-capacity guarantee reached an agent/home capacity limit', result);
    }
  };
  proto.__citySimWorkforceCoverageV1015 = true;
}
