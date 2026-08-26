# City-Sim Architecture

This document summarizes the current implementation at `v0.1.83`. **Source code is authoritative.** Historical phase documents are kept under `doc/archive/` and are not current architecture specifications.

## Runtime overview

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
  │   ├─ Agent / Pedestrian / POI worker pools
  │   └─ rail-passenger integration
  ├─ RailNetworkPlan
  ├─ RailRenderer + rail runtime enhancement chain
  ├─ EnhancedRenderer -> InstancedRenderer
  ├─ External high-speed rail subsystem
  ├─ UniversalInspector / Dashboard / PerformanceMonitor
  ├─ render filters / UI window management
  └─ FirstPersonController

version.ts
  └─ current runtime tuning import chain
```

`src/version.ts` is not only a version constant. It is also the explicit import entry for many runtime tuning modules. Import order can therefore change behavior.

## Startup and time model

1. `CityConfigLoader` reads `/config/city.json`, validates ranges, and resolves the seed.
2. `World` constructs the city and runs procedural generation.
3. Runtime tuning layers refine generation, traffic, logistics, workplace status, rendering, and UI.
4. The loading screen keeps the normal simulation running during pre-roll so visible startup begins from a stabilized morning state.
5. Simulation time and `requestAnimationFrame` are decoupled. High time scales may batch simulation work and reduce render cadence while backlog exists.
6. Conventional rail uses its own frame budget/backlog handling.

## Data ownership

Large citizen and road-vehicle state uses SoA TypedArrays. SharedArrayBuffer is used when the environment supports cross-origin isolation, allowing worker pools to avoid cloning the full population.

`World` coordinates citizen decisions, POI reservations, walking/driving/bus/taxi transitions, activities and logistics hooks. Rail passenger integration is attached through bridge/sidecar state rather than placing all rail-specific fields in the base AgentStore.

`RailRenderer` still mixes rail operational and rendering responsibilities. This is current technical debt.

## City generation

The base generator creates city planning, hierarchical roads, blocks/parcels, buildings, POIs and facilities. Runtime generation tuning then adds or refines:

- urban-footprint guards;
- height/use diversity;
- density-aware local-road variation;
- rural industry and fleet depots;
- multi-block agricultural estates;
- final station-area building clearance;
- final park quotas by surrounding height tier.

Road hierarchy is:

```text
Highway > Arterial > Collector > Local > Path
```

Arterials are multi-lane by default: CBD/Commercial can use three lanes per direction and other areas two. High-density Collectors may use two lanes per direction; lower-density Collectors and Locals are normally one lane per direction.

### Parks

`planning.parkRatio` is an early planning input, not the final park count. The current final pass limits retained parks approximately to:

- high/super-high-rise surroundings: 2% of classified blocks;
- mid-rise surroundings: 1%;
- low-rise surroundings: 5%.

The final pass only removes excess generated parks; it does not manufacture parks to fill a quota.

### Station-area clearance

Two concepts coexist:

1. rail-envelope clearance removes objects that physically interfere with the running railway/station geometry;
2. the final generation refinement enforces a no-building radius around every station.

Current final radius before adding the building half-diagonal:

- Central / SubCenter: 78 m
- Local / Terminal: 56 m

Production sites and facility records whose buildings are retired by this final clearance are removed from their corresponding runtime registries.

### Rural industry and agriculture

The rural industry layer creates:

- taxi depot;
- bus depot;
- freight depot;
- farm / raw-factory / processor / assembler production sites.

Agricultural estates convert legacy small farm sites into larger multi-block land-use areas. A farm contains a field, office and warehouse, and public roads are suppressed through the farm interior. The final refinement may expand the field further where road/building/farm collision checks allow it.

For farms, field coordinates are separate from logistics coordinates: trucks load at the warehouse/access side, while production capacity and rendering use the cultivated field extent.

## Workplace and production model

Workplace attendance distinguishes three numbers:

- **present**: assigned workers currently `Engaged` at their work POI;
- **assigned**: residents whose `workPOI` points to that workplace;
- **capacity**: Work POI capacity.

Production-site efficiency is:

```text
efficiency = present / capacity
actual process rate = base process rate × efficiency
```

Farm base process rate is derived from cultivated area, so two equally staffed farms can still have different absolute output if their field sizes differ.

The physical supply chain is:

```text
farm / raw-factory
        ↓ stage 0
processor
        ↓ stage 1
assembler
        ↓ stage 2
Retail / Food or city-gate export
```

No general money/price/profit economy is currently modeled for these workplaces.

## Road mobility

Cars, trucks, buses and taxis use RoadNetwork and TrafficSystem. Signals, pedestrian conflicts and IDM-style following remain part of the base traffic logic.

### Multi-lane traffic

`MultiLaneTrafficTuning` adds lane assignment/lane changes and turn-lane behavior. `TurningLaneTransitionFix` separates intersection turn-lane convergence from ordinary downstream lane-count reduction, so a vehicle is not forced to satisfy contradictory lane requirements before a turn.

### Turning visualization

`TurningVisualPathTuning` changes the displayed pose near an intersection without replacing the logical edge/path model. It connects the actual incoming turn lane to the outgoing lane with a quadratic curve during the first portion of the outgoing edge. This prevents multi-lane turns from visibly side-slipping when the outgoing lane offset changes.

### Pedestrian crossings

`PedestrianCrossingSafetyTuning` keeps vehicle/pedestrian conflict occupancy valid across the whole crossing.

`PedestrianSignalWaitTuning` preserves the pedestrian route on a red signal, lets the pedestrian approach to about 1.15 m from the crossing entry, then holds position until the pedestrian signal and vehicle conflict state permit entry.

## Bus network

The base `BusSystem` still supplies stop creation and bus runtime state. `ShortBusRouteTuning` replaces normal network construction with short local routes.

- old grid lines are split into at least four sections;
- actual Road A* distance is measured;
- total cyclic route length is limited to 5,000 m;
- target length is about 4,600 m;
- each route runs 3 or 4 buses;
- routes at least ~3.2 km or with many stops run 4 buses;
- Central/SubCenter rail feeders are also shortened to the same 5 km limit.

`FleetDepotOperations` keeps bus spawning compatible with the bus depot.

## Taxi service

`TaxiSystem` manages idle, pickup, boarding, occupied and alighting phases. The target fleet is approximately population / 800, clamped to 18–120 and vehicle-store availability.

`TaxiIntegration` makes trips of at least 350 m eligible for taxi selection. Choice probability varies by resident wealth, night time, trip distance, fallback state, and visitor purpose. Taxi passengers reuse existing high-level agent states for compatibility, while taxi-specific state is kept in TaxiSystem side data.

## Freight logistics

`IndustrialLogisticsTuning` replaces simple gate-to-store replenishment when the physical supply-chain runtime is available.

Truck fleet size is based on production-site count, clamped to 18–72. Trucks have 240-unit cargo capacity and perform explicit source travel, loading, destination travel, unloading and depot return phases. Final products can replenish Retail/Food POIs or leave through city gates as exports.

## Conventional railway

Rail planning starts before final city development so station influence can affect land-use planning. After roads exist, railway paths are aligned to the road network.

`RailRuralStationSpacing` keeps the configured `railStationSpacing` as a base spacing and gradually expands actual planning spacing toward the outskirts. The locality multiplier ranges from roughly 1.0 near the core to 2.0 at the outer radius.

The railway runtime includes three-trunk-line planning in the standard config, optional sub-center spurs, local/rapid/limited services, right-hand operation, blocks/signals, passing loops, terminal/depot handling, a 15-second timetable quantum and physical passengers.

The consist-position invariant remains one scalar running distance per train; individual cars are sampled from the same smoothed line around that value.

## Station geometry and passengers

Visible station architecture follows the final smoothed rail. Platforms, roofs, passenger waiting positions and access routes should not be maintained on independent conflicting trajectories.

Station equipment includes benches, vending machines, emissive fluorescent fixtures, platform lighting and ceiling-hung departure indicators.

Rail passengers physically walk into the station, use station access geometry, wait on a platform, board an actually stopped train, ride, alight and return to street level. One transfer is currently supported.

## Rendering

`EnhancedRenderer` uses GPU instancing and distance LOD for large urban scenes. Additional rendering tunings cover rural fields, forests, road markings, taxi appearance, signals and render filters.

`TreeRoadClearanceTuning` performs a final spatial test against real road segments and suppresses street/forest trees that fall inside road clearance.

## Inspector and UI

`UniversalInspector` is extended by runtime tuning modules.

Workplace inspection can show:

```text
workplace type
present / assigned / capacity
production or operating efficiency
```

Production-site labels distinguish farm, raw factory, processor, assembler and logistics/fleet facilities.

Debug/validation UI includes the statistics HUD, time/speed dashboard, render filter, Performance Monitor and pinned tracking information. Window position/size/visibility persistence is handled by the UI tuning layer.

## Performance principles

- SoA TypedArrays
- SharedArrayBuffer and worker pools where available
- GPU instancing
- distance LOD
- spatial indexes
- A* route cache
- active/dirty-set clearing
- separate simulation/render/rail budgets and instrumentation

## Known architectural debt

- `RailRenderer` still mixes operations and rendering.
- Prototype-patch behavior is import-order dependent.
- `src/version.ts` is both version metadata and a runtime patch entrypoint.
- Taxi passenger compatibility currently reuses bus-like base AgentState values.
- Some final-generation tuning removes/reclassifies data after earlier generation phases rather than using one unified reservation model.
- Physical production exists, but a full monetary economy is not yet modeled.
