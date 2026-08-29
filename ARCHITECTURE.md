# Machi-Sim Architecture

> Target: `develop` / synchronized at v1.0.30 / 2026-08-27. **Source code is authoritative.** Historical phase documents under `doc/archive/` are not current architecture specifications.

## 1. Runtime overview

```text
main.ts
  ├─ CityConfigLoader / BootScreen / PreRoll
  ├─ World
  │   ├─ SimulationClock
  │   ├─ AgentStore / NeedSystem / UtilityBrain
  │   ├─ CityGenerator / CityPlanning / BlockParcelLayout
  │   ├─ RoadNetwork / SidewalkNetwork
  │   ├─ VehicleStore / TrafficSystem / SignalSystem
  │   ├─ BusSystem / TaxiSystem / LogisticsSystem
  │   ├─ PowerSystem
  │   ├─ Agent / Pedestrian / POI worker pools
  │   └─ rail-passenger integration
  ├─ RailNetworkPlan
  ├─ RailRenderer + rail runtime enhancement chain
  ├─ EnhancedRenderer -> InstancedRenderer
  ├─ External high-speed rail subsystem
  ├─ UniversalInspector / Dashboard / PerformanceMonitor
  ├─ FullScreenMenu + analytics / interaction / power extensions
  ├─ render filters / UI window management
  └─ FirstPersonController

version.ts
  └─ current runtime tuning import chain + APP_VERSION
```

`src/version.ts` is both version metadata and an explicit import entry for runtime tuning modules. Prototype wrappers are order-sensitive, so import order is part of the effective runtime specification.

## 2. Startup and ownership

1. `CityConfigLoader` reads `/config/city.json`, merges defaults and validates ranges.
2. `CityGenerator` builds planning, roads, blocks/parcels, buildings and POIs.
3. Generation tunings refine urban footprint, rural industry, agriculture, station clearance, parks and power-facility building reservations.
4. `World` initializes citizens, transport systems, logistics and power integration.
5. Pre-roll advances the normal simulation before the visible start.
6. Static rendering, rail, dynamic meshes, Inspector and UI are created.
7. Simulation time is decoupled from `requestAnimationFrame`; high speeds use batching/backlog control.

Large citizen and road-vehicle state uses SoA TypedArrays. SharedArrayBuffer is used when cross-origin isolation is available.

`World` coordinates high-level behavior, POI reservations, transport transitions and system integration. Specialized runtimes keep side data when forcing all state into AgentStore or VehicleStore would make the base stores too wide.

## 3. City generation

The base pipeline is:

```text
CityPlanning
→ hierarchical RoadNetwork
→ Block / Parcel
→ Building / POI
→ facility / park planning
→ generation refinement layers
```

Important refinement layers include:

- `UrbanFootprintBaseline`
- `CityDiversityTuning`
- `ParkPriorityTuning`
- `UrbanFootprintGuard`
- `RuralIndustryAndDepotTuning`
- `AgriculturalEstateTuning`
- `AgriculturalEstateIndexGuard`
- `CityGenerationRefinement`
- `PowerFacilityGeneration`

Road hierarchy:

```text
Highway > Arterial > Collector > Local > Path
```

Arterials and high-density Collectors can be multi-lane. Lower-density areas reduce Local-road density.

### 3.1 Parks and station clearance

`planning.parkRatio` is an early planning input. A final pass removes excess parks by surrounding height tier; it does not create missing parks to reach a quota.

Rail/station clearance has two responsibilities:

- physical rail-envelope clearance;
- final station-centered no-building clearance.

Production/facility registries are synchronized if a building is retired by the final pass.

### 3.2 Rural industry and agriculture

Rural generation provides taxi/bus/freight depots and physical production sites. Farms are multi-block estates with separate cultivated-field extent and road-access/logistics coordinates.

The physical production chain is:

```text
farm / raw-factory
        ↓
processor
        ↓
assembler
        ↓
Retail / Food or city-gate export
```

This is a physical inventory/logistics model, not a full money/price/profit economy.

### 3.3 Power facilities as normal buildings

`PowerFacilityGeneration` runs during city generation, before World population bootstrap. It selects already generated, road-fronting Buildings while excluding reserved special facilities, production sites and fleet depots.

Selected Buildings are converted to one of:

- thermal generation;
- solar generation;
- substation;
- external grid connection.

The Building keeps its normal `id`, parcel/frontage, raycast/Inspector/LOD path and receives a dedicated Work POI. Power integration binds logical power assets to these Building records and uses the frontage-side road node for electrical/logistics access.

The renderer does not create a second independent facility at another coordinate. Facility-specific visual details are attached to the same Building: thermal stacks, solar panels, transformer/switchgear details and facility-specific color treatment.

## 4. Workplace and lifeline staffing

General workplaces distinguish:

- `present`: scheduled workers physically `Engaged` at the assigned Work POI;
- `assigned`: residents whose `workPOI` points to the workplace;
- `capacity`: Work POI capacity.

Physical production uses workplace efficiency, further multiplied by power operational effects where applicable.

Lifeline workplaces add different semantics:

- `scheduled`: workers whose current shift is active;
- `onDuty`: scheduled workers who checked in at the workplace during the current shift, plus temporary startup/handover grace;
- `concurrentStaff`: target simultaneous staffing.

A worker who actually checked in remains `onDuty` for the same shift during a short meal/break even when not physically inside the POI. A check-in does not carry to another workplace or another shift.

Current grace periods:

- shift handover: 45 simulation minutes;
- attendance-runtime startup: 60 simulation minutes.

For generation facilities, roster size is the facility workforce capacity. Three shifts schedule that roster; `lifelineOnDutyRatio=0.30` means 30% of the roster on duty is treated as 100% staffing for operational capability. The old “roster = concurrent target × three shifts × relief ratio” model is no longer current.

## 5. Road mobility

Cars, trucks, buses and taxis share RoadNetwork and TrafficSystem. Signals, pedestrian conflict handling and IDM-style following remain logical constraints.

`MultiLaneTrafficTuning` adds lane runtime and turn-lane behavior. `TurningLaneTransitionFix` separates turn-lane requirements from downstream lane-count reduction. `TurningVisualPathTuning` changes displayed pose through intersections without rewriting logical RoadEdge/path state.

Pedestrians preserve their sidewalk route while waiting at a red crossing and resume the same route once signal/conflict conditions allow entry.

## 6. Bus, taxi and freight

`ShortBusRouteTuning` rebuilds normal bus topology as short local routes. Actual Road A* cyclic route length is limited to 5 km; routes normally use 3–4 buses.

`TaxiSystem` owns taxi phases and passenger mappings in side data while remaining compatible with base vehicle/agent state.

`IndustrialLogisticsTuning` operates real trucks between supply-chain sites. Fire-generation fuel delivery is a second truck workflow integrated through `LifelineSupplyIntegration`: internal raw-factory surplus is preferred, otherwise a city gate is used as the import source.

## 7. Power architecture

`PowerSystem` owns logical generation, external import, substations, underground line segments, consumers, zones, dispatch and snapshots.

Road edges are reused as the topology for underground power paths. Cables/poles are not rendered in normal view.

Hard delivery constraints are currently:

- electrical connectivity / broken line state;
- online source/substation state;
- connected Power Zone supply capacity.

Healthy line and substation nameplate ratings are **soft overload diagnostics**, not instantaneous load-shedding caps. Actual flow can exceed rating and set overload flags. A future protection/thermal-trip model can use those flags. This avoids artificial blackouts while a connected zone still has adequate source capacity.

Generation dispatch order is effectively internal generation before external import. Therefore external import is a useful diagnostic signal that available internal generation is below demand in the connected zone.

Generation capability is constrained by:

```text
base available output
× staffing factor
× fuel factor (thermal only)
```

Fuel stock is consumed from actual thermal generation and replenished only after a fuel truck completes unloading.

## 8. Railway

Rail planning starts early enough for station influence to affect city development. Running lines are aligned to the road network after roads exist.

`RailRuralStationSpacing` treats configured spacing as a base and expands it gradually toward the outskirts.

Rail runtime includes local/rapid/limited services, right-hand operation, blocks/signals, passing/terminal/depot behavior, deadhead operation, a 15-second timetable quantum and physical passengers.

`RailRenderer` still mixes some operational and rendering responsibility and remains architectural debt.

## 9. Rendering and UI

`EnhancedRenderer` uses GPU instancing and distance LOD. Normal Building rendering is authoritative for all ordinary and power-facility Buildings.

The F10 menu is layered:

- `FullScreenMenuTuning`: base lists/settings shell;
- `PowerUiTuning`: power tab and building power annotations;
- `FullScreenMenuAnalyticsTuning`: metric cards and lightweight SVG/CSS charts;
- `FullScreenMenuInteractionTuning`: truck tab, normalized train analytics and jump fixes;
- `PowerFacilityJumpTuning`: power-row jump resolution through Building binding;
- `PowerFacilityBuildingVisualTuning`: power-specific detail geometry and Inspector labeling.

Current menu surfaces include buildings, cars, buses, taxis, trucks, trains, power and graphics settings. Jump actions resolve the actual simulation entity/Building before moving the camera.

Power analytics records one sample per simulation minute, keeps up to 120 samples and draws the recent demand/supply/internal-generation/external-import series without an external chart library.

## 10. Performance principles

- SoA TypedArrays
- SharedArrayBuffer / worker pools where available
- GPU instancing
- distance LOD
- spatial indexes
- A* route cache
- active/dirty-set clearing
- separate simulation/render/rail budgets and instrumentation
- topology/consumer/path caches in the power system

## 11. Known architectural debt

- `RailRenderer` still mixes operations and rendering.
- Prototype-patch behavior is import-order dependent.
- `src/version.ts` is both version metadata and runtime patch entrypoint.
- Several UI extensions discover/augment the F10 DOM instead of sharing one typed menu registry.
- Some final-generation tuning reclassifies existing generated Buildings rather than using a single unified reservation planner.
- Power overload is currently diagnostic; time-dependent thermal protection/trip behavior is not yet modeled.
- Physical production exists, but a full monetary economy is not implemented.

## 12. Planned architecture

The next major diagnostic layer is a common city overlay system. `ROADMAP.md` defines the planned OverlayManager and traffic/power-first rollout. It is intentionally not documented here as current behavior until implementation lands.
