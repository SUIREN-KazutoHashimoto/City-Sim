# City-Sim Architecture

City-Sim is a browser-based real-time city simulation built with TypeScript, three.js and Vite.

The current default scenario is a 100 km² city with 50,000 citizens, road traffic, buses, freight logistics and a working passenger railway system.

For maintained Japanese documentation, start at:

- `doc/README.md` — documentation index
- `doc/現行仕様書.md` — authoritative current specification
- `doc/基本設計書.md`
- `doc/機能設計書.md`
- `doc/詳細設計書.md`
- `doc/設定ファイル仕様.md`

`doc/CityGeneratorV2_Phase*.md` files are historical design records and are not the authoritative current specification.

## Runtime structure

```text
main.ts
  ├─ CityConfigLoader
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
  ├─ RailRenderer
  │   ├─ train operations / timetable / blocks / signals
  │   └─ railway enhancement modules
  ├─ EnhancedRenderer -> InstancedRenderer
  ├─ TrainLiveryOverlay
  ├─ Inspector / Dashboard / Performance Monitor
  └─ FirstPersonController
```

## Data-oriented simulation

Citizens and road vehicles use SoA TypedArrays. When cross-origin isolation is available, SharedArrayBuffer allows worker pools to update shared state without copying the entire population.

`World` remains the main coordinator for citizen activities, POI reservation and multimodal transitions.

Rail operations are currently maintained by `RailRenderer`, which therefore owns both railway operational state and railway rendering state. Passenger code accesses it through a smaller transit-provider bridge instead of directly depending on all renderer internals.

## City generation

Current city generation includes:

- CBD and sub-centers
- commercial and mixed-use areas
- high/low density residential districts
- industrial and logistics districts
- civic facilities and parks
- hierarchical roads: Highway > Arterial > Collector > Local > Path
- block/parcel generation with frontage, depth, setback and development intensity
- schools, hospitals, universities, city hall, police/fire facilities, malls, supermarkets, hotels, gas stations and stadiums

Rail planning is calculated before final city development influence, then aligned to the completed road network.

## Mobility

Citizens can currently travel by:

- walking
- private car
- route bus
- railway

Railway use is not a teleport abstraction. A rail passenger walks to a station entrance, follows a 3D station-access route, waits on the platform, boards an actually stopped train, rides with that train, gets off on a platform and walks back to street level. One transfer is currently supported.

## Railway network

The default configuration uses three trunk rail lines plus optional sub-center spurs.

Rail alignment follows road corridors, but the raw road A* polyline is simplified to avoid small repeated zig-zag curves. Terminal stations are pulled away from the road center and connected through dedicated smooth approaches.

### Track operation

Trunk double track uses right-hand running:

```text
path direction +1 -> lane -1
path direction -1 -> lane +1
```

Each inter-station interval has three blocks per direction. Exceptional reverse running through crossovers is reserved for delay/deadlock recovery and requires the opposing interval to be clear.

A stopped train keeps its arrival lane/platform for the entire dwell. Lane changes for the next direction begin only when departure routing starts.

### Signals

A physical signal describes the block immediately beyond it:

- red: immediate block unavailable
- yellow: immediate block clear, following block unavailable
- green: two blocks ahead clear

Compatible reservations made for the same direction/lane are treated as passable for that route.

Block boundaries inside station platforms remain operational but their physical signal posts are hidden, preventing signals from standing in the middle of a platform.

### Services

Trunk lines operate local, rapid and limited services. Fleet size scales with station count. Reserve local trains are used during the morning and evening peaks.

Typical service window:

- 05:00 service start
- 23:30 last-departure baseline
- 07:00–09:30 morning peak
- 17:00–19:30 evening peak

Train motion uses a single scalar `run.distance` as the consist position. All car poses are derived from it. Per-car independent following/smoothing must not be introduced because it breaks consist stability.

## Terminals and depots

Terminal stations use a four-track fan. During a terminal dwell, the assigned physical platform remains stable and the train converges to its normal right-hand main line after departure.

Depots are generated only at real `RailStationKind.Terminal` stations. A depot is currently short and wide rather than a long city-center yard:

- 8 storage tracks
- 4.4 m track spacing
- about 260 m depth
- shared lead and ladder

Spur fleets may use the nearest real terminal depot.

## Rail passengers

Rail routing considers nearby origin/destination stations, direct trips and one-transfer trips. Walking access, initial waiting time, train travel and transfer time are compared to pure walking.

Passenger rail states extend the Agent state machine:

```text
ToRailStation -> WaitingTrain -> OnTrain
```

Passenger-specific board/alight/train arrays live in a World-side rail passenger data store rather than expanding AgentStore with all rail details.

### Station circulation

Multi-level interchange stations connect adjacent platform levels rather than giving every level a separate street staircase:

```text
upper platform
  -> next lower platform
  -> ...
  -> lowest platform
  -> street
```

Inter-platform stairs are constrained to platform-safe geometry and should not cross train clearance diagonally.

Ground access keeps height while crossing road space, moves outside the roadway, and only then descends to street level.

## Railway rendering

Rail rendering is built from instanced primitive geometry.

Current visible features include:

- route/service train stripes
- station and track lighting
- train head/tail lamp pairs attached to the actual first/last car matrices
- green departure indicators
- blinking amber approach indicators
- road-aware elevated support columns/portal beams
- station exterior architecture built from thin walls, glazing, frames and roof elements

Station architecture must remain hollow/walkable; it must not be replaced by one solid box filling the interior.

## Rail extension chain

The railway is currently implemented through `RailRenderer` plus prototype-patch enhancement modules. Import order is behaviorally significant.

Current high-level order:

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
```

`RailPassengerAutoAttach` additionally loads stair-clearance, ground-stair and passenger-integration patches.

Long-term cleanup should fold stabilized behavior into explicit rail-operation/station models and reduce prototype-patch ordering dependencies.

## Dashboard and inspection

The 24-hour activity dashboard uses 288 five-minute bins and currently displays:

- home
- work
- food
- leisure/shopping
- driving
- bus
- railway
- walking
- idle

The railway series counts only citizens actually in `OnTrain`.

Train inspection includes train service/state plus passenger count, capacity and load percentage. Current passenger capacity is a simplified 120 people per car.

## Performance principles

- SoA TypedArrays for large dynamic populations
- SharedArrayBuffer where available
- worker pools for expensive population/POI/pedestrian work
- GPU instancing for repeated geometry
- static geometry generated once
- rendering/simulation LOD
- spatial indexes instead of repeated global scans
- performance instrumentation separating render and simulation costs

The default 100 km² / 50,000 citizen configuration is also a stress-test configuration. See `doc/性能モニタ仕様.md` for runtime diagnostics.
