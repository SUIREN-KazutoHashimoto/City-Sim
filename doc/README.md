# City-Sim ドキュメント索引

## 1. 仕様の優先順位

City-Simでは**現行ソースコードを最終的な正**とする。

```text
現行ソースコード
  > 現行仕様書
  > 基本設計書 / 機能設計書 / 詳細設計書
  > 分野別仕様書
  > archive の履歴資料
```

ドキュメントとコードが矛盾する場合は、先に現行コードで実効挙動を確定し、文書をコードへ追従させる。仕様そのものを変更する場合は、コード変更と検証を先に行う。

## 2. 現行ドキュメント

| 文書 | 役割 |
|---|---|
| `現行仕様書.md` | v0.1.83時点の外部挙動・主要数値・制約の横断スナップショット |
| `基本設計書.md` | システム構成、責務、データ所有、設計原則 |
| `機能設計書.md` | 機能単位の入力・処理・出力・主要制約 |
| `詳細設計書.md` | Runtime patch順、重要定数、実装上の不変条件 |
| `設定ファイル仕様.md` | `public/config/city.json` の生設定と、runtime実効値との違い |
| `性能モニタ仕様.md` | Performance Monitorの表示値と診断用途 |
| `性能設計_レンダリングLOD・並列化.md` | 大規模描画/並列化の設計背景 |

ルートの `README.md` は導入用、`ARCHITECTURE.md` はコード構造を短く把握するためのアーキテクチャ概要とする。

## 3. 履歴資料

旧Phase資料、旧CityGenerator仕様、過去の追補資料は [`archive/`](archive/) へ移動した。

これらは「当時どう設計したか」を追跡するための資料であり、**現在の動作を保証しない**。内容は原則として書き換えず、現行仕様へのリンク元として使わない。

## 4. 現行ソース対応表

| 分野 | 主なソース |
|---|---|
| 起動/時間/描画loop | `src/main.ts`, `src/boot/PreRoll.ts`, `src/core/SimulationClock.ts` |
| Runtime tuning入口/版番号 | `src/version.ts` |
| 設定 | `public/config/city.json`, `src/config/CityConfigLoader.ts` |
| 都市計画/基礎生成 | `CityPlanning.ts`, `CityGenerator.ts`, `BlockParcelLayout.ts`, `SpecialFacilityPlanner.ts` |
| 都市多様化/道路密度 | `CityDiversityTuning.ts`, `RuralIndustryAndDepotTuning.ts` |
| 農地 | `AgriculturalEstateTuning.ts`, `AgriculturalEstateIndexGuard.ts`, `CityGenerationRefinement.ts` |
| 駅周辺土地利用 | `RailStationClearance.ts`, `CityGenerationRefinement.ts` |
| 公園最終整理 | `CityGenerationRefinement.ts` |
| 市民/行動 | `AgentStore.ts`, `NeedSystem.ts`, `UtilityBrain.ts`, `World.ts` |
| 道路交通 | `TrafficSystem.ts`, `MultiLaneTrafficTuning.ts`, `TurningLaneTransitionFix.ts`, `TurningVisualPathTuning.ts` |
| 横断歩道 | `PedestrianCrossingSafetyTuning.ts`, `PedestrianSignalWaitTuning.ts` |
| バス | `BusSystem.ts`, `ShortBusRouteTuning.ts`, `FleetDepotOperations.ts` |
| タクシー | `TaxiSystem.ts`, `TaxiIntegration.ts`, `FleetDepotOperations.ts` |
| 物流/生産 | `LogisticsSystem.ts`, `IndustrialLogisticsTuning.ts`, `WorkplaceProductivityTuning.ts` |
| 営業所/郊外産業 | `RuralIndustryAndDepotTuning.ts` |
| 鉄道計画 | `RailPlanning.ts`, `RailPlanningEnhancements.ts`, `RailRuralStationSpacing.ts`, `RailSpurConsistency.ts` |
| 鉄道コア運行 | `RailRenderer.ts`, `RailTimetable.ts`, `RailFrameScheduler.ts` |
| 終端/基地/運行tuning | `RailRendererEnhancements.ts`, `RailDepotPlacement.ts`, `RailStationOperationsTuning.ts`, `RailStationRuntimeV033.ts` |
| 駅ホーム/設備 | `RailStationArchitecture.ts`, `RailPlatformIndicators.ts`, `RailLightingAndIndicators.ts` |
| 鉄道旅客 | `RailPassengerIntegration.ts`, `RailPassengerBridge.ts`, `RailPassengerDemand.ts`, `RailPassengerMetrics.ts` |
| 駅動線 | `RailPassengerStationAccess.ts` と Stair/Ground系patch |
| 外部高速鉄道 | `ExternalRailConnection.ts`, `HighSpeedRailRegistry.ts`, `HighSpeedScheduleTuning.ts` |
| 都市描画 | `EnhancedRenderer.ts`, `MultiLaneRoadRendering.ts`, `RuralIndustryRendering.ts`, `ForestRendering.ts` |
| 道路上樹木除外 | `TreeRoadClearanceTuning.ts` |
| Inspector | `UniversalInspector.ts`, `WorkplaceInspectorTuning.ts`, `WorkplaceRosterInspectorTuning.ts`, Taxi/Visitor/MultiLane inspector tuning |
| UI/Performance | `Dashboard.ts`, `PerformanceMonitor.ts`, `RenderFilter*`, `UiNoiseReduction.ts` |

## 5. 現在の重要な実効仕様

### 鉄道駅間隔

`city.json` の `railStationSpacing=525` は**基準値**。`RailRuralStationSpacing` により郊外ほど間隔が広がり、中心付近の約1.0倍から外縁の最大約2.0倍まで変化する。

### 公園

`planning.parkRatio=0.055` は初期計画用。最終公園数は高さ帯で再整理される。

- 高層/超高層周辺: 約2%
- 中層周辺: 約1%
- 低層周辺: 約5%

### バス

- 1路線の実道路循環距離: 5 km以下
- 旧長距離路線を最低4分割
- 1路線3～4台
- 駅フィーダーも同じ5 km上限

### 農地/生産

- 複数区画の畑 + 事務所 + 倉庫
- 畑面積が100%稼働時の絶対生産量を決定
- 実生産量は出勤率でスケール

### 職場

Inspectorでは `出勤 / 在籍 / 定員` を区別する。生産拠点の効率は出勤÷定員で実際のprocess rateへ反映する。

## 6. 変更時の文書チェック

- 外部から見える挙動変更 → `現行仕様書.md`, `機能設計書.md`
- 責務/構成変更 → `基本設計書.md`, `ARCHITECTURE.md`
- Patch/定数/実装方式変更 → `詳細設計書.md`
- JSON項目/検証/実効値変更 → `設定ファイル仕様.md`
- Performance指標/測定UI変更 → `性能モニタ仕様.md`
- 代表仕様が変わった → ルート `README.md`
- 履歴資料は原則更新しない

## 7. 数値を書くときのルール

数値は、可能な限り次を区別して記載する。

- JSONに書かれた**生設定**
- runtime patch後の**実効値**
- 生成結果によって変動する**目標/上限**
- seedや都市形状に依存する**概数**

例: `railStationSpacing=525 m` は基準値であり、全駅が525 m間隔になるという意味ではない。
