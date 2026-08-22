# City-Sim Architecture

City-Sim is a browser-based real-time city simulation built with TypeScript, three.js and Vite.

The simulation is organized around a data-oriented execution layer (SoA TypedArrays) coordinated by `World`, with thin OOP/domain facades where useful. Rendering reads simulation state but does not own it.

For the maintained Japanese design documents, see:

- `doc/基本設計書.md`
- `doc/機能設計書.md`
- `doc/詳細設計書.md`

## Runtime structure

```text
main.ts
  ├─ World
  │   ├─ SimulationClock
  │   ├─ AgentStore / NeedSystem / UtilityBrain
  │   ├─ CityGenerator
  │   │   ├─ RoadNetwork
  │   │   ├─ POIRegistry
  │   │   ├─ ParkingLot
  │   │   └─ Building / BuildingArchetype
  │   ├─ SidewalkNetwork / AStar(walk)
  │   ├─ VehicleStore / TrafficSystem / AStar(drive)
  │   ├─ SignalSystem
  │   ├─ BusSystem
  │   └─ LogisticsSystem
  ├─ EnhancedRenderer -> InstancedRenderer
  ├─ Inspector
  ├─ Dashboard
  └─ FirstPersonController
```

## Simulation design

### Agents

Citizens are stored in `AgentStore` using SoA arrays. They have needs, occupation, work schedules, home/work POIs, wealth, age, personality and mobility state.

`NeedSystem` decays needs. `UtilityBrain` evaluates sleep/eat/work/shopping/leisure/home actions and selects a destination.

Longer trips prefer a parked private car, then a direct bus route, then walking.

### Traffic

Road and sidewalk graphs are separate.

- Driving A*: travel-time cost (`length / speedLimit`)
- Walking A*: distance cost
- Vehicle following: IDM-style acceleration
- Signals: concurrent and scramble programs
- Pedestrian crossings: signal and vehicle occupancy checks

Buses and delivery trucks use the same road/traffic system as private vehicles.

### POI and logistics

POIs have capacity/occupancy. Food/Retail POIs also have stock/maxStock. Delivery trucks leave external gates and replenish low-stock stores.

## City generation

`CityGenerator` uses FBM-based urbanization and a calibrated threshold to generate roads, blocks, parking and buildings.

Building use (`POICategory`) and visible building form (`BuildingArchetype`) are intentionally separate.

Current archetypes include detached houses, town houses, apartments, residential towers, offices, office towers, shops, retail boxes, commercial blocks, mixed-use buildings and leisure halls.

Each `Building` also carries rendering-oriented style data:

```text
archetype
roofType
palette
styleSeed
rotation
urbanity
```

`MixedUse` is not a POI category; it is a building archetype that registers multiple POIs in one building.

## Rendering

`InstancedRenderer` remains the compatibility layer used by the Inspector for representative raycast meshes.

`EnhancedRenderer` extends it and keeps the GPU-instancing strategy while making objects more recognizable without relying on texture-heavy assets.

### Buildings

The original one-box building mesh is kept as a transparent full-height raycast hit proxy. Visible buildings are rebuilt from instanced primitive parts:

- colored shell/base
- stepped upper volumes/towers
- facade/glass panels
- roof forms
- rooftop mechanical units
- retail awnings

### Vehicles

The representative vehicle mesh is supplemented with:

- cabin/window volume
- two wheel/axle parts
- head lamp
- tail lamp

Private cars receive several visual proportions derived from vehicle id/color. Buses and trucks use dedicated dimensions.

### Pedestrians

The original capsule remains as the raycast representative. Torso, head and two legs are layered on top, with simple leg swing derived from simulation time and walking speed.

### Street environment

Static instancing adds:

- curbs
- arterial medians
- highway guard rails
- parking-space markings
- street lights
- trees
- bus-stop shelters and benches

### Day/night

`main.ts` derives solar state from `SimulationClock.dayPhase` and updates sky/fog color, directional light position/intensity/color, and hemisphere intensity.

## Performance principles

- SoA TypedArrays for large dynamic populations
- GPU Instancing for repeated geometry
- static details built once
- dynamic details synchronized during existing agent/vehicle passes
- no per-object high-poly model requirement
- explicit instance-count caps for decorative systems where needed

Future large-scale work should add simulation LOD, rendering LOD/chunking, route caching and worker-based processing.
