# Machi-Sim 性能設計：レンダリングLOD・並列化

## 1. 文書情報

- 対象: 現行実装（文書同期時点 `v0.1.41`）
- 更新基準日: 2026-08-25
- **現行ソースコードを正とする。**
- 本書は「将来候補」ではなく、現在実装されている大規模化・並列化の構造を整理する。

## 2. 目的

100 km²・人口5万人級の標準都市を維持したまま、次を両立する。

- simulation throughput
- camera/UI responsiveness
- render FPS
- 大量Agent/Vehicle/Building/Rail objectの可視化
- 高倍率simulation時のbacklog制御
- bottleneckを測定可能なinstrumentation

## 3. 基本方針

### 3.1 SoA + TypedArray

大量Agent/Vehicle stateはObject配列ではなくSoA TypedArrayを基本とする。

利点:

- contiguous memory
- cache locality
- SharedArrayBuffer化
- Worker range分割
- bulk/native TypedArray operation

### 3.2 SharedArrayBuffer

cross-origin isolated環境ではAgentStoreを中心にSharedArrayBufferを使用する。

Dev/previewではCOOP/COEP headerを有効化する。SharedArrayBufferが使えない環境ではfallback pathを持つ。

### 3.3 常駐Worker Pool

現行は少なくとも次のWorker系を持つ。

- `AgentWorkerPool`
- `POISearchWorkerPool`
- `PedestrianWorkerPool`

Workerをstepごとに生成破棄しない。

## 4. Agent Worker

Agentごとに独立性の高いNeed/Engaged系更新をWorkerへ分配する。

Coordinator整合性が必要な:

- UtilityBrain decision
- POI reserve/release
- trip mode transition
- final activity completion

等はWorld側で確定する。

複数fixed stepをbatch化できる部分はまとめ、Worker message回数を抑える。

## 5. POI Search Worker

POI候補検索をmain-thread full scanから分離する。

設計:

- POI static dataをWorker側へ保持
- category/positionを空間index化
- queryをbatch送信
- occupancy等の動的値は共有可能な配列で参照
- Workerはbest candidateを返す
- reserve/releaseの最終確定はCoordinator

これにより「検索」と「共有資源の更新」を分離する。

## 6. Pedestrian Worker

歩行者は単純ID range分割だけでは近傍衝突回避が成立しないため、共有snapshot + spatial indexを使う。

現行step概念:

```text
Wake workers
  ↓
previous used spatial cells sparse-clear
  ↓
position snapshot
  ↓
barrier
  ↓
linked-cell spatial index parallel build
  ↓
barrier
  ↓
avoid + movement
  ↓
DONE epoch
```

### Spatial index

- cell size: 8 m
- 都市全cellを毎step全clearしない
- 前stepで使ったcellだけをactive/used listからclear

### Completion

対応環境では `Atomics.waitAsync` を利用でき、message-only pollingへ依存しない。fallback pathは維持する。

## 7. A*最適化

A*は徒歩・道路移動・鉄道路線道路alignment等で高頻度使用される。

現行方針:

- searchごとの全node work-array初期化を避ける
- touched nodeだけreset
- heap position trackingでdecrease-key
- static graph向けLRU route cache
- routing開始数へsimulation-step budget

### 制約

Route cacheはgraph topologyが静的であることを前提とする。runtime road editを導入する場合はcache invalidation/versioningが必須。

## 8. Simulation / Render非同期化

`main.ts` はsimulation batch完了を毎RAFの前提にしない。

- requestAnimationFrameはcamera/UI/renderを継続
- simulation workはbatchで進める
- unprocessed real/sim timeはbacklog/debtとして保持
- speed epoch変更時は古いpending real timeをrebaseし、速度変更前の借金を新速度へ持ち込まない

高倍率ではrender cadenceを落としてsimulation CPUを確保する。

## 9. RailFrameScheduler

Rail operationはWorldと別budgetを持つ。

目的:

- high time scaleで1frameにrail stepを無制限実行しない
- rail CPUがUI/renderを占有しない
- operationとvisual sync回数を分離する

設計:

- input sim secondsをpendingへ加算
- timeScaleに応じrail step sizeを調整
- frame step count制限
- CPU budget超過時は打切り
- 残りをRailBacklogとして次frameへ繰越
- dynamic rail visualは可能な限りframe単位でまとめて同期

## 10. GPU Instancing

大量の同種geometryは `THREE.InstancedMesh` を基本とする。

対象例:

- buildings
- road markings / signal parts
- Agent body parts
- road vehicles
- rail / sleepers / supports
- platform parts
- train proxy/visible parts

Object数を削減し、draw-call/GC負荷を抑える。

## 11. LOD

`EnhancedRenderer` がcamera distanceとfollow状態等から静的/動的LODを切り替える。

設計原則:

- 近景: detail geometry
- 中景: simplified representation
- 遠景: coarse massing / object omission
- LOD transitionはcamera移動量と距離を基準に必要時だけ更新
- Inspector用raycast proxyと可視geometryを分離できる

具体的な距離thresholdはRendererの現行constantを正とし、本書へ固定値を複製しすぎない。

## 12. Dynamic visual sync

Agent/Vehicle/Railのsimulation stateからGPU instance matrixへ同期する処理自体もCPU costを持つ。

現行では描画フィルターがOFFのcategoryについて、一部visual syncをskipできる。

対象例:

- pedestrians
- road vehicles
- road signals

Rail rolling stockは `RenderFilterRailSplit` によりrail infrastructureと別categoryで制御する。

### 注意

Filterはsimulationを停止しない。Performance切り分け用であり、通常全表示のrender performanceとは条件が違う。

## 13. Vehicle visual smoothing

Simulation batch間のroad vehicle position/heading飛びを `VehicleVisualSmoother` がrender timeで補間する。

`TrafficTurningTuning` がsimulation pose自体をBezier turnへ改善済みなので、Smootherはcurved poseへ素早く追従し、heading lagでside-slipに見えないrateを使う。

Simulation collision/occupancyへvisual interpolationを戻さない。

## 14. Train rendering

Train consistはRailRendererの `run.distance` から各car matrixを算出する。`TrainLiveryOverlay` はそのfinal matrixをvisible shellへ転写する。

別render trajectoryを作らないことで:

- curve
- siding
- crossover
- terminal
- spur

でproxyとvisible trainがずれないようにする。

## 15. Lighting cost

実Lightは無制限生成しない。

例:

- train front SpotLightはpoolし最大編成数を制限
- station PointLightはplatform単位で生成するがshadowは無効
- emissive geometryとreal Lightを用途分離

Lightingがbottleneckの場合はPerformance Monitorのlighting/GPU項目とvisible light数を確認する。

## 16. UI/Performance instrumentation

Performance Monitor自体は通常hiddenで、必要時だけGUI/`P`で開く。描画filterも通常hidden。

Debug windowを常駐させてsimulation viewを占有せず、必要な計測だけ開く。

Monitorは:

- Frame
- Pre-render
- Render
- GPU
- SIM
- Worker/Ped/Traffic/A*/Rail等のsub-metric
- workload件数

を分離する。

## 17. Hot-pathで避ける処理

- 毎step全容量TypedArray clear
- 毎framestatic geometry再生成
- 全POI scan
- 全Agent×全Trainの総当たり
- Workerの頻繁なcreate/terminate
- rail time catch-upの1frame無制限loop
- visibleでないcategoryの不要instance sync
- routing queryごとの全A* work array fill

## 18. 性能変更の検証

Before/Afterは以下を固定する。

- seed
- config
- population/capacity
- camera/follow
- simulation speed
- render filter state
- debug window state

比較するもの:

1. Frame/SIM/Render/GPU
2. workload count
3. backlog
4. per-agent/per-vehicle cost
5. simulation semanticsが変わっていないか

## 19. 現行の技術的負債

- RailRenderer operation/render混在によりrail最適化の責務境界が広い
- Prototype patch chainで最終methodが追いにくい
- SharedArrayBuffer非対応fallbackとの二重path
- static graph前提A* cacheは将来のroad editと相性が悪い
- Debug filterを使うとrender workload自体が変わるためbenchmark条件管理が必要
