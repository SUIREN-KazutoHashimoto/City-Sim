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

## 2. 現行ドキュメント

| 文書 | 役割 |
|---|---|
| `現行仕様書.md` | 現行developの外部挙動・主要数値・制約の横断スナップショット |
| `基本設計書.md` | システム構成、責務、データ所有、設計原則 |
| `機能設計書.md` | 機能単位の入力・処理・出力・主要制約 |
| `詳細設計書.md` | Runtime patch順、重要定数、実装上の不変条件 |
| `設定ファイル仕様.md` | `public/config/city.json` の生設定とruntime実効値 |
| `電力システム仕様.md` | 発電、地下系統、変電所、需要、停電、三相/電力品質、UI、性能の現行仕様 |
| `性能モニタ仕様.md` | Performance Monitorの表示値と診断用途 |
| `性能設計_レンダリングLOD・並列化.md` | 大規模描画/並列化の設計背景 |
| `開発・不具合修正手順.md` | branch、version、CI、PR、bugfixの標準手順 |

ルートの `README.md` は導入用、`ARCHITECTURE.md` はコード構造概要とする。`archive/` は履歴資料であり現在の動作を保証しない。

## 3. 現行ソース対応表

| 分野 | 主なソース |
|---|---|
| 起動/時間/描画loop | `src/main.ts`, `src/boot/PreRoll.ts`, `src/core/SimulationClock.ts` |
| Runtime tuning入口/版番号 | `src/version.ts` |
| 設定 | `public/config/city.json`, `src/config/CityConfigLoader.ts` |
| 電力コア | `src/power/PowerSystem.ts`, `PowerTypes.ts`, `PowerDemandModel.ts` |
| 電力品質/運用 | `PowerQualityModel.ts`, `PowerQualityIntegration.ts`, `PowerOperationalIntegration.ts` |
| 電力性能 | `PowerPerformanceTuning.ts`, `scripts/power-phase12-benchmark.mjs` |
| 電力UI | `src/rendering/PowerUiTuning.ts` |
| 市民/行動 | `AgentStore.ts`, `NeedSystem.ts`, `UtilityBrain.ts`, `World.ts` |
| 道路交通 | `TrafficSystem.ts`, `MultiLaneTrafficTuning.ts`, `TurningLaneTransitionFix.ts` |
| バス/タクシー | `BusSystem.ts`, `TaxiSystem.ts`, `FleetDepotOperations.ts` |
| 物流/生産 | `LogisticsSystem.ts`, `IndustrialLogisticsTuning.ts`, `WorkplaceProductivityTuning.ts` |
| 鉄道 | `RailRenderer.ts`, `RailTimetable.ts`, `RailFrameScheduler.ts` |
| 都市描画 | `EnhancedRenderer.ts`, `MultiLaneRoadRendering.ts`, `ForestRendering.ts` |
| Inspector/UI | `UniversalInspector.ts`, `Dashboard.ts`, `PerformanceMonitor.ts` |

## 4. 現在の重要な実効仕様

- 電力: P1〜P10/P12実装済み。P11オーバーレイのみ未実装。詳細は`電力システム仕様.md`。
- 電力更新: 配電5 simulation秒、需要再計算15 simulation秒を標準とする。
- 鉄道駅間隔: `railStationSpacing=525`は基準値で、郊外ほど最大約2倍。
- 公園: 最終段で高さ帯別quotaへ整理。
- バス: 1路線の実道路循環距離5 km以下。
- 職場: Inspectorで出勤/在籍/定員を区別し、生産効率へ反映。

## 5. 変更時の文書チェック

- 外部挙動 → `現行仕様書.md`, `機能設計書.md`
- 責務/構成 → `基本設計書.md`, `ARCHITECTURE.md`
- Patch/定数/実装方式 → `詳細設計書.md`
- JSON項目 → `設定ファイル仕様.md`
- 電力 → `電力システム仕様.md`（設定変更なら設定仕様も）
- Performance → `性能モニタ仕様.md` または該当分野の性能節
- 履歴資料は原則更新しない
