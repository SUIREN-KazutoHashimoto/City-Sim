# City-Sim ドキュメント索引

## 1. 仕様の優先順位

City-Simでは**現行ソースコードを唯一の最終的な正**とする。

```text
現行ソースコード
  > 現行仕様書
  > 基本設計書 / 機能設計書 / 詳細設計書
  > 個別仕様書
  > Phase資料・過去の追補資料
```

ドキュメントとコードが矛盾する場合はコードを変更せず、まず文書側を実装へ追従させる。仕様そのものを変えたい場合は、コード変更と検証を先に行う。

## 2. 現行ドキュメント

| 文書 | 役割 |
|---|---|
| `現行仕様書.md` | 現在動いている機能・数値・制約の横断スナップショット |
| `基本設計書.md` | システム構成、責務、データ所有、設計方針 |
| `機能設計書.md` | ユーザー/ドメイン機能ごとの入力・処理・出力・制約 |
| `詳細設計書.md` | 実装モジュール、Patch順、重要定数・不変条件 |
| `設定ファイル仕様.md` | `public/config/city.json` の生設定、検証範囲、実効値との関係 |
| `性能モニタ仕様.md` | Performance Monitorと性能診断の意味 |
| `性能設計_レンダリングLOD・並列化.md` | 大規模描画/並列化の設計背景 |

ルートの `README.md` は導入用、`ARCHITECTURE.md` はコード構造を短く把握するための英語寄りアーキテクチャ概要とする。

## 3. 開発履歴資料

次は履歴保存用であり、現在の動作を保証しない。

- `CityGeneratorV2_Phase3.md`
- `CityGeneratorV2_Phase4.md`
- `CityGeneratorV2_Phase4_5.md` ～ `CityGeneratorV2_Phase4_14.md`
- `CityGeneratorV2仕様.md`
- `CityGeneratorV2_開発強度モデル.md`
- `設計書追補_バス停・夜間照明.md`

これらは「当時どう設計したか」を追跡するため原則書き換えない。

## 4. 現行ソース対応表

| 分野 | 主なソース |
|---|---|
| 起動/時間/描画loop | `src/main.ts`, `src/boot/PreRoll.ts`, `src/core/SimulationClock.ts` |
| 設定 | `public/config/city.json`, `src/config/CityConfigLoader.ts` |
| 都市計画/生成 | `CityPlanning.ts`, `CityGenerator.ts`, `BlockParcelLayout.ts`, `SpecialFacilityPlanner.ts` |
| 駅周辺土地利用 | `RailStationClearance.ts` |
| 市民/行動 | `AgentStore.ts`, `NeedSystem.ts`, `UtilityBrain.ts`, `World.ts` |
| 道路交通 | `TrafficSystem.ts`, `TrafficTurningTuning.ts`, `VehicleVisualSmoother.ts` |
| バス/物流/信号 | `BusSystem.ts`, `LogisticsSystem.ts`, `SignalSystem.ts` |
| 鉄道計画 | `RailPlanning.ts`, `RailPlanningEnhancements.ts`, `RailSpurConsistency.ts` |
| 鉄道コア運行 | `RailRenderer.ts`, `RailTimetable.ts`, `RailFrameScheduler.ts` |
| 右側通行/渡線 | `RailRightHandOperation.ts` |
| 終端/基地 | `RailRendererEnhancements.ts`, `RailDepotPlacement.ts` |
| 駅進入/回送/15秒ダイヤ | `RailStationOperationsTuning.ts`, `RailStationRuntimeV033.ts` |
| 駅ホーム/外装/設備 | `RailStationArchitecture.ts` |
| 発車案内板 | `RailPlatformIndicators.ts` |
| 鉄道照明/案内灯 | `RailLightingAndIndicators.ts` |
| 高架支持 | `RailSupportClearance.ts` |
| 列車外装/前照灯 | `TrainLiveryOverlay.ts` |
| 鉄道旅客 | `RailPassengerIntegration.ts`, `RailPassengerBridge.ts`, `RailPassengerDemand.ts`, `RailPassengerMetrics.ts` |
| 駅動線 | `RailPassengerStationAccess.ts`, `RailPassengerStairClearance.ts`, `RailPassengerGroundStairs.ts` |
| 外部高速鉄道 | `ExternalRailConnection.ts`, `HighSpeedRailRegistry.ts`, `HighSpeedScheduleTuning.ts` |
| Inspector | `UniversalInspector.ts` (`Inspector.ts` はexport入口) |
| 活動/時間UI | `Dashboard.ts` |
| 性能 | `PerformanceMonitor.ts` |
| 描画フィルター | `RenderFilterTuning.ts`, `RenderFilterRailSplit.ts` |
| デバッグウィンドウ管理 | `UiNoiseReduction.ts` |

## 5. 変更時の文書チェック

- 外部から見える挙動変更 → `現行仕様書.md`, `機能設計書.md`
- 責務/構成変更 → `基本設計書.md`, `ARCHITECTURE.md`
- Patch/定数/実装方式変更 → `詳細設計書.md`
- JSON項目/検証/実効設定の関係変更 → `設定ファイル仕様.md`
- Performance指標/測定UI変更 → `性能モニタ仕様.md`
- READMEに載せる代表仕様が変わった → ルート `README.md`

## 6. 数値を書くときのルール

設定ファイルの値と実行時の実効値が異なる可能性があるため、必ずどちらかを明記する。

例: 現行 `city.json` の `railStationSpacing` は525 m。`RailPlanningEnhancements`には既定値を1.5倍する処理もあるが、通常起動ではJSONの明示値が後段mergeで優先されるため、現行の実効値も525 mである。
