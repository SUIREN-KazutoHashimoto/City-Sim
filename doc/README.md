# City-Sim ドキュメント索引

## 現行仕様

現行 `develop` の仕様確認は、次の順で参照する。

1. **`現行仕様書.md`** — 現在動作している仕様の正本。都市生成、交通、鉄道、旅客、駅、描画、UIを横断して記載する。
2. **`基本設計書.md`** — システム構成、責務、主要データ、非機能方針。
3. **`機能設計書.md`** — 機能単位の入力・処理・出力・制約。
4. **`詳細設計書.md`** — ソースモジュール、主要メソッド、Patch適用順、実装上の不変条件。
5. **`設定ファイル仕様.md`** — `public/config/city.json` の項目と現行値。
6. **`性能モニタ仕様.md` / `性能設計_レンダリングLOD・並列化.md`** — 大規模都市向け性能設計。

仕様の優先順位は次のとおり。

```text
現行ソースコード
  > 現行仕様書
  > 基本/機能/詳細設計書
  > Phase資料・追補資料
```

ドキュメントとソースが矛盾する場合はソースを正とし、ドキュメントを追従更新する。

---

## 開発履歴資料

以下は City Generator v2 / 鉄道機能が段階的に追加された時点の設計メモであり、**現在の仕様を直接保証しない**。

- `CityGeneratorV2_Phase3.md`
- `CityGeneratorV2_Phase4.md`
- `CityGeneratorV2_Phase4_5.md`
- `CityGeneratorV2_Phase4_6.md`
- `CityGeneratorV2_Phase4_7.md`
- `CityGeneratorV2_Phase4_8.md`
- `CityGeneratorV2_Phase4_9.md`
- `CityGeneratorV2_Phase4_10.md`
- `CityGeneratorV2_Phase4_11.md`
- `CityGeneratorV2_Phase4_12.md`
- `CityGeneratorV2_Phase4_13.md`
- `CityGeneratorV2_Phase4_14.md`

これらは「なぜ現在の仕様になったか」を追うために残す。後続Phaseや現行仕様書と矛盾しても、履歴保存のため原則として過去資料を書き換えない。

その他:

- `CityGeneratorV2仕様.md` — City Generator v2 初期仕様
- `CityGeneratorV2_開発強度モデル.md` — 開発強度モデル
- `設計書追補_バス停・夜間照明.md` — 当時の追加仕様

---

## 主な現行ソースの対応表

| 分野 | 主なソース |
|---|---|
| 都市設定 | `public/config/city.json`, `src/config/CityConfigLoader.ts` |
| 都市計画 | `src/generation/CityPlanning.ts`, `BlockParcelLayout.ts` |
| 鉄道計画 | `src/generation/RailPlanning.ts`, `RailPlanningEnhancements.ts` |
| 市民 | `src/agents/AgentStore.ts`, `UtilityBrain.ts` |
| 道路交通 | `src/traffic/TrafficSystem.ts`, `SignalSystem.ts`, `BusSystem.ts` |
| 鉄道運行 | `src/rendering/RailRenderer.ts`, `RailTimetable.ts` |
| 右側通行/信号 | `RailRightHandOperation.ts`, `RailSignalPlatformClearance.ts`, `RailLightingAndIndicators.ts` |
| 終端/基地 | `RailRendererEnhancements.ts`, `RailDepotPlacement.ts` |
| 鉄道旅客 | `src/world/RailPassengerIntegration.ts`, `RailPassengerDemand.ts`, `RailPassengerMetrics.ts` |
| 駅動線 | `RailPassengerStationAccess.ts`, `RailPassengerStairClearance.ts`, `RailPassengerGroundStairs.ts` |
| 駅外装/支持 | `RailStationArchitecture.ts`, `RailSupportClearance.ts` |
| 列車外装 | `TrainLiveryOverlay.ts` |
| UI/統計 | `Dashboard.ts`, `Inspector.ts`, `TrainPassengerInspector.ts` |

---

## 更新チェック

機能追加・仕様変更時は、次を確認する。

- 数値・設定値が変わった → `現行仕様書.md`、`設定ファイル仕様.md`
- システム構成/責務が変わった → `基本設計書.md`, `ARCHITECTURE.md`
- ユーザーから見える機能が変わった → `機能設計書.md`
- モジュール/メソッド/Patch順が変わった → `詳細設計書.md`
- 鉄道のPrototype Patchを追加した → `現行仕様書.md` の適用順と `詳細設計書.md` を必ず更新
- Phase資料 → 履歴として原則変更しない
