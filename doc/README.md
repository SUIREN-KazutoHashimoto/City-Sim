# Machi-Sim ドキュメント索引

> Target: `develop` / synchronized at v1.0.30 / 2026-08-27

## 1. 仕様の優先順位

Machi-Simでは**現行ソースコードを最終的な正**とする。

```text
現行ソースコード
  > 現行仕様書
  > 基本設計書 / 機能設計書 / 詳細設計書
  > 分野別仕様書
  > archive の履歴資料
```

`ROADMAP.md` は将来計画であり、現行仕様の根拠ではない。

## 2. 文書の役割

| 文書 | 役割 | 更新する場面 |
|---|---|---|
| `../README.md` | 利用者・初見開発者向け入口 | 主要機能、標準構成、導入方法が変わる |
| `../ARCHITECTURE.md` | コード構造と責務の概要 | 所有関係、データフロー、主要レイヤーが変わる |
| `現行仕様書.md` | 現行developの外部挙動・主要制約の横断スナップショット | ユーザーから見える挙動が変わる |
| `基本設計書.md` | 設計原則、責務、境界、不変条件 | システムの考え方や責務分担が変わる |
| `機能設計書.md` | 機能単位の入力・処理・出力・制約 | 機能追加・削除・機能間連携が変わる |
| `詳細設計書.md` | runtime patch順、重要定数、実装上の契約 | patch順、実装方式、重要定数が変わる |
| `設定ファイル仕様.md` | `public/config/city.json` とLoader検証 | JSON項目・既定値・値域が変わる |
| `電力システム仕様.md` | 発電、地下系統、変電所、燃料、人員、電力品質、UI | 電力分野を変更する |
| `性能モニタ仕様.md` | Performance Monitor表示値と診断用途 | 計測項目・表示・診断意味が変わる |
| `性能設計_レンダリングLOD・並列化.md` | 大規模描画/並列化の設計背景 | LOD、Worker、描画予算を大きく変更する |
| `開発・不具合修正手順.md` | branch、version、CI、PR、bugfix標準手順 | 開発フローやrepository rulesが変わる |
| `../ROADMAP.md` | 未実装の中長期計画 | 計画の追加・優先度変更・完了時 |

## 3. 現行ソース対応表

| 分野 | 主なソース |
|---|---|
| 起動/時間/描画loop | `src/main.ts`, `src/boot/PreRoll.ts`, `src/core/SimulationClock.ts` |
| Runtime tuning入口/版番号 | `src/version.ts` |
| 設定 | `public/config/city.json`, `src/config/CityConfigLoader.ts` |
| 都市生成 | `CityGenerator.ts`, generation tuning群 |
| 電力施設Building生成 | `src/generation/PowerFacilityGeneration.ts` |
| 電力コア | `src/power/PowerSystem.ts`, `PowerTypes.ts`, `PowerDemandModel.ts` |
| 電力配電/容量調整 | `PowerGridCapacityTuning.ts`, `PowerDeliveryTuning.ts` |
| 電力品質/運用 | `PowerQualityModel.ts`, `PowerQualityIntegration.ts`, `PowerOperationalIntegration.ts` |
| ライフライン人員 | `LifelineWorkforce.ts`, `WorkforceCoverageTuning.ts`, `WorkplaceProductivityTuning.ts` |
| 火力燃料 | `GenerationFuelModel.ts`, `LifelineSupplyIntegration.ts` |
| 電力施設binding/表示 | `PowerFacilityBuildingBinding.ts`, `PowerFacilityBuildingVisualTuning.ts`, `PowerFacilityJumpTuning.ts` |
| 電力UI | `PowerUiTuning.ts`, `FullScreenMenuAnalyticsTuning.ts` |
| 市民/行動 | `AgentStore.ts`, `NeedSystem.ts`, `UtilityBrain.ts`, `World.ts` |
| 道路交通 | `TrafficSystem.ts`, `MultiLaneTrafficTuning.ts`, `TurningLaneTransitionFix.ts` |
| バス/タクシー | `BusSystem.ts`, `TaxiSystem.ts`, `FleetDepotOperations.ts` |
| 物流/生産 | `LogisticsSystem.ts`, `IndustrialLogisticsTuning.ts`, `WorkplaceProductivityTuning.ts` |
| 鉄道 | `RailRenderer.ts`, `RailTimetable.ts`, `RailFrameScheduler.ts` |
| 都市描画 | `EnhancedRenderer.ts`, `MultiLaneRoadRendering.ts`, `ForestRendering.ts` |
| F10全画面メニュー | `FullScreenMenuTuning.ts`, `FullScreenMenuAnalyticsTuning.ts`, `FullScreenMenuInteractionTuning.ts` |
| Inspector/UI | `UniversalInspector.ts`, `Dashboard.ts`, `PerformanceMonitor.ts` |

## 4. 現在の重要な実効仕様

- 標準設定は100 km²、人口50,000、Agent capacity 120,000、Vehicle capacity 30,000。
- 電力更新は5 simulation秒、需要再計算は15 simulation秒。
- 電線・電柱は地下埋設扱いで通常描画しない。一方、発電所・変電所・外部受電所は通常Buildingとして都市生成へ参加する。
- ライフライン職場は3交代。ロスター全体の30%がon-dutyなら100% staffing efficiencyとする。
- ライフラインの`onDuty`は同一シフト中の実チェックインを保持し、短い離席で発電能力を即時喪失しない。
- 健全な電力線・変電所の定格は現在、即時遮断のhard capではなく過負荷診断値。接続障害とZone供給力はhard constraint。
- F10メニューは建物、乗用車、バス、タクシー、トラック、列車、電力、グラフィックスを扱い、複数ページで軽量グラフを表示する。
- 電力画面は市内発電余力と外部受電余力を分け、需給時系列を1 simulation分間隔で記録する。
- 都市診断オーバーレイは未実装。交通・電力から始める共通オーバーレイ基盤として`../ROADMAP.md`に計画済み。

## 5. 重複を避けるルール

同じ情報を複数文書へ詳細コピーしない。

- 数値の一覧 → `設定ファイル仕様.md` または該当分野仕様
- 現在どう動くか → `現行仕様書.md`
- なぜその責務構成か → `基本設計書.md` / `ARCHITECTURE.md`
- 機能の入出力・制約 → `機能設計書.md`
- patch名・順序・内部定数 → `詳細設計書.md`
- 将来やりたいこと → `../ROADMAP.md`

分野固有の詳細が肥大化した場合は分野別仕様書へ分離し、横断文書からは要約とリンクだけを残す。

## 6. 変更時チェック

- 外部挙動 → `現行仕様書.md`, `機能設計書.md`
- 責務/構成 → `基本設計書.md`, `../ARCHITECTURE.md`
- Patch/定数/実装方式 → `詳細設計書.md`
- JSON項目 → `設定ファイル仕様.md`
- 電力 → `電力システム仕様.md`（設定変更なら設定仕様も）
- Performance → `性能モニタ仕様.md` または `性能設計_レンダリングLOD・並列化.md`
- 開発運用 → `開発・不具合修正手順.md`
- 未実装計画 → `../ROADMAP.md`
- 履歴資料 → 原則更新しない

## 7. archive

`archive/` は過去Phase、旧仕様、設計判断の履歴を保存する場所であり、現在の動作を保証しない。

現行文書から外す情報でも、後から経緯を確認する価値がある場合は削除せずarchiveへ移す。単なる誤記・重複・現行コードと無関係な古い値は、履歴価値がなければ現行文書から削除してよい。
