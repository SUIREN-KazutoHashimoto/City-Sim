# City-Sim Architecture

This document describes the current implementation. **Source code is authoritative; this document follows the code.** Historical `doc/CityGeneratorV2_Phase*.md` files are not current architecture specifications.

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
  │   ├─ BusSystem / LogisticsSystem
  │   ├─ Agent / Pedestrian / POI worker pools
  │   └─ RailPassengerIntegration
  ├─ RailNetworkPlan
  ├─ RailRenderer + rail runtime enhancement chain
  ├─ RailFrameScheduler
  ├─ EnhancedRenderer -> InstancedRenderer
  ├─ VehicleVisualSmoother -> TrafficTurningTuning
  ├─ TrainLiveryOverlay
  ├─ External high-speed rail subsystem
  ├─ Inspector / Dashboard / PerformanceMonitor
  ├─ RenderFilterTuning / RenderFilterRailSplit
  ├─ UiNoiseReduction window manager
  └─ FirstPersonController
```

## Startup and time model

1. `CityConfigLoader` reads `/config/city.json`, validates ranges and resolves the seed.
2. `World` constructs and generates the city.
3. The loading screen remains visible while the real simulation is pre-rolled to 08:00.
4. Static road/building/rail geometry and dynamic visual stores are built.
5. Dashboard, Inspector, Performance Monitor and follow controls are attached.
6. Simulation time and `requestAnimationFrame` are decoupled. At high time scales, simulation work may be batched and rendering cadence reduced while backlog is present.
7. `RailFrameScheduler` gives rail operations a per-frame CPU budget and carries unprocessed rail simulation seconds forward as rail backlog.

## Data ownership

Large citizen and road-vehicle state uses SoA TypedArrays. When cross-origin isolation is available, SharedArrayBuffer allows worker pools to update shared state without cloning the full population.

`World` coordinates citizen decisions, trips, POI reservations, bus/logistics and multimodal transitions. `RailRenderer` currently owns both rail operational state and rail rendering state; passenger code uses a smaller transit-provider bridge instead of directly depending on all rail internals.

This mixed responsibility in `RailRenderer` is current technical debt, not an intended long-term boundary.

## City generation

Current generation includes CBD, sub-centers, residential/commercial/mixed-use districts, industry/logistics, civic facilities, parks, hierarchical roads, blocks/parcels, development intensity and POIs.

Road hierarchy:

```text
Highway > Arterial > Collector > Local > Path
```

Rail planning exists before final TOD sampling, while final rail alignment is performed after the road network exists.

### Station-area clearance

`RailStationClearance` clears only buildings/parking that intersect the actual rail envelope. It does not convert whole station blocks into parks. Around Central/SubCenter stations, safe non-facility frontage buildings are restyled as 2–4 floor Food/Retail/Leisure-oriented low-rise commercial buildings.

## Road mobility

Walking uses the SidewalkNetwork; cars, trucks and buses use RoadNetwork and TrafficSystem. Signals, pedestrian blocking and IDM-style following remain edge based.

### Vehicle cornering

`TrafficTurningTuning` replaces the old “position snaps to the next straight edge while heading catches up later” behavior. Intersection turns use one cubic Bezier trajectory whose tangent also defines vehicle heading.

Nominal turn radii:

- passenger car: 10.5 m
- truck: 15 m
- bus: 18 m

The upcoming turn temporarily caps the free-road speed target; IDM/signal/following logic remains responsible for acceleration and spacing. `VehicleVisualSmoother` performs only render-time interpolation and does not alter the traffic simulation state.

## Conventional railway planning

The normal configuration creates three trunk lines and optional sub-center spurs.

### Running line vs station metadata

This distinction is important:

- `station.plannedX/Z` remains the planning/TOD location.
- `station.x/z` may stay off the road for terminal/open-space station context.
- `station.roadNode` is the road-network connection.
- **`line.path` is constructed from road A* node positions and is not pulled toward the station metadata position.**

Only near-collinear road points are removed. The old wide “38 m trunk / 28 m spur corridor chord simplification” and station-specific S-curve insertion are not current behavior.

`RailCurveTuning` only softens source vertices sharper than 90 degrees before the normal rail smoothing step.

### Spur rules

`RailSpurConsistency` ensures that:

- a spur branches from a trunk station;
- very short candidates promote the nearby trunk station instead of creating a one-stop stub;
- a real spur has at least junction + intermediate + sub-center stations;
- rendered spur rail and spur trains use the same track-offset function.

## Railway operations

Trunk lines are double track with right-hand operation. Rail blocks, signals, dispatch reservations, crossovers and local passing loops are managed by RailRenderer.

The consist position invariant is one scalar `run.distance`. All cars are sampled from the same smoothed line around that scalar position. Independent per-car following must not be introduced.

The timetable uses a 180-second repeating terminal pattern and a 15-second quantum. Scheduled arrival/departure and normal dwell values are quantized to the same 15-second grid by `RailStationRuntimeV033`.

Outside service hours and on depot release, trains use non-revenue `deadhead` operation. Deadhead trains stop only at endpoints, use short terminal dwell, and are shown as 回送 states through inspection.

## Station geometry

`RailStationArchitecture` suppresses the legacy platform/roof geometry and owns the visible station slab/canopy.

Key effective geometry:

- platform top: rail reference + 1.05 m
- roof center: +4.45 m
- roof thickness: 0.18 m
- terminal platform minimum length: 270 m
- siding/outside track offset: 10.4 m
- terminal platform width: 4.8 m
- ordinary side platforms are slightly wider than the original base width; island platforms receive a smaller width increase

Platforms and station components follow the final smoothed running line, so gentle station curves are supported. The station is not forced into a separate straight path that can diverge from the rail.

Station architecture remains hollow/walkable and uses thin walls/glazing/fascia rather than a solid filled box.

### Station equipment

Current platform equipment includes benches, vending machines, emissive fluorescent fixtures and a real PointLight per platform. Ceiling-hung departure boards are small, perpendicular to the platform axis and display up to three departures. Island platforms place the two track boards side-by-side.

## Train rendering and lighting

`TrainLiveryOverlay` copies the final RailRenderer car matrices into visible shell/window/route/service meshes; it does not invent another train trajectory.

Conventional train headlights include visible lamps plus a pooled set of real SpotLights aimed forward. Rail/station indication lights are separate from the departure board.

## External high-speed rail

The external high-speed subsystem is operational rather than decorative. It has its own running trains, dwell/service schedule, passenger load and central-station visitor exchange, while exposing train snapshots through `HighSpeedRailRegistry` for Inspector/follow support.

The former always-visible external-line status panel is intentionally removed from the normal UI. High-speed train status remains available through selection/tracking.

## Rail enhancement chain

Import order is behaviorally significant. Current high-level order from `TrainLiveryOverlay.ts` is:

```text
RailPlanningEnhancements
RailRendererEnhancements
RailDepotPlacement
RailRightHandOperation
RailSignalPlatformClearance
RailLightingAndIndicators
RailSupportClearance
RailStationArchitecture
PedestrianSignalOrientation
RailPassengerStationAccess
RailPassengerAutoAttach
RailPassengerVisualConsistency
RailPassengerDemand
TrainPassengerInspector
RailStationRuntimeV033
  ├─ RailStationOperationsTuning
  └─ RailSpurConsistency
```

`RailPassengerAutoAttach` also loads stair-clearance, ground-stair and passenger-integration patches. Later patches may wrap methods replaced by earlier patches, so import order changes require behavior review.

## Rail passengers

Railway use is physical rather than teleport-based: citizens walk to station access, use 3D station circulation, wait on the platform, board an actually stopped train, ride with it, alight on a platform and return to street level. One transfer is currently supported.

Passenger rail state is held in World-side sidecar arrays/maps rather than expanding every AgentStore row with all rail-specific fields.

## Rendering filters

Validation rendering is grouped by parent `THREE.Group` so visibility cannot be re-enabled accidentally by child lighting/update code. Categories include ground, roads/signals/bus stops, buildings/parks/facilities, rail infrastructure, road vehicles, pedestrians and rolling stock.

Rail infrastructure (`線路・駅設備`) and rolling stock (`列車`) are independent. The train category includes conventional visible train meshes, headlights/SpotLights and external high-speed rolling stock. Filtering changes rendering/sync work only; the simulation continues.

## Debug UI/window management

Debug/validation panels are managed as movable/resizable windows:

- statistics/FPS HUD
- time/speed dashboard
- render filter
- Performance Monitor
- pinned tracking information

Window position, size and visibility persist in localStorage. A bottom-right `UI` launcher provides GUI visibility toggles and layout reset. `P`, `F9` and `G` shortcuts remain available.

## Performance principles

- SoA TypedArrays for large dynamic populations
- SharedArrayBuffer and worker pools where available
- GPU instancing for repeated geometry
- static geometry generated once when possible
- simulation/render LOD
- spatial indexes and A* route cache
- active/dirty-set clearing instead of repeated full-array clears in hot paths
- performance instrumentation separating simulation, pre-render, render and GPU costs

## Known architectural debt

- RailRenderer mixes operations and rendering.
- The rail prototype-patch chain is long and import-order dependent.
- Some runtime tuning is applied by patching private implementation methods/fields.
- The configured `railStationSpacing` currently overrides the attempted default `×1.5` tuning, so normal launches still use 525 m.
- Station access/architecture remains procedural rather than using one explicit shared station-geometry model.
