# City Generator v2 仕様（Phase 1）

## 目的

従来の「Noiseで市街地判定 → 均一グリッド道路 → 各Blockで用途をランダム抽選」から、都市計画の意味を先に生成する方式へ移行する。

生成順序は以下を基本とする。

1. City Planning
2. CBD / 副都心 / 工業・物流拠点
3. District / 地価 / 密度
4. 道路階層
5. 地区別の道路密度
6. Block / Parcel近似
7. Building / POI
8. Gate / バス / 物流（既存システムへ接続）

## District

`DistrictType` は以下を持つ。

- CBD
- Commercial
- MixedUse
- ResidentialHigh
- ResidentialLow
- Industrial
- Logistics
- Civic
- Park

CBDは都市中央付近をseedで少しずらして生成する。副都心はCBD周辺へ複数生成する。Industrial / Logisticsは都市外縁へ寄せ、LogisticsはGateに近い位置を優先する。

District判定にはCBD/副都心からの距離、工業・物流中心からの距離、複数スケールのNoiseを利用する。

## 市街化度・地価・密度

以下は別の値として扱う。

- `urbanScore`: 市街地として採用するか
- `landValue`: 地価
- `density`: 建物密度・高さの基準

`urbanRatioTarget` は従来同様、サンプリングした `urbanScore` の分位点から閾値を校正する。

地価はCBD/副都心への近さを強く評価し、Industrial / Logisticsでは低下させる。建物階数は `density` と `landValue` の組み合わせから決定するため、「市街地だが低層の工業地」と「高地価・高密度のCBD」を分離できる。

## 道路階層

既存互換のためRoadClassの既存数値は維持し、Collectorを追加する。

階層:

1. Highway
2. Arterial
3. Collector
4. Local
5. Path

標準設定:

- Arterial: 約900m間隔
- Collector: 約360m間隔
- Local: `blockSize` を基準としDistrictごとに間引く

Local道路密度:

- CBD / Commercial / MixedUse / ResidentialHigh: 1倍
- ResidentialLow / Civic: 2倍街区相当
- Industrial / Logistics / Park: 3倍街区相当

道路グラフ自体は既存A* / Sidewalk / Traffic / Busとの互換性を維持するため、Phase 1では基準グリッド上に構築する。道路の存在密度と階層だけをDistrict別に変える。

## 信号

原則としてArterial/Collector同士の交差点へ設置する。CBDではArterialとLocalの一部交差点にも設置する。

従来の「市街地ノードの大半が信号候補」より、道路階層に基づく配置へ変更する。

## 建物用途

建物用途はDistrictと接道道路クラスの両方から決定する。

例:

- CBD: Work / Retail / Food / MixedUseを多くする
- Commercial: Retail / Food / Work中心
- ResidentialHigh: Home中心だが幹線沿いはRetail / Food増加
- ResidentialLow: Home中心。Arterial沿いだけ沿道商業を増やす
- Industrial: Work中心
- Logistics: Work中心
- Park: 原則空地。低確率でLeisure施設のみ

これにより「住宅街の内部まで商業が均一に散る」状態を抑え、幹線道路沿いに商業軸を作る。

## 建物Archetype追加

- Factory
- Warehouse

Industrial / Logisticsでは低層・大きめのParcel近似サイズで生成する。

## 駐車場

Districtごとに生成率を変更する。

- CBD: 少ない
- Commercial / MixedUse: 中程度
- ResidentialLow: 多め
- Industrial: 多め
- Logistics: 最多
- Park: 原則なし

## 外部設定

`public/config/city.json` の `planning` で以下を変更できる。

```json
{
  "planning": {
    "subCenters": 3,
    "arterialSpacing": 900,
    "collectorSpacing": 360,
    "industrialRatio": 0.08,
    "parkRatio": 0.055
  }
}
```

## Phase 2候補

Phase 1では既存Simulationとの互換性を優先し、道路は基準グリッドを下地としている。

次段階では以下を候補とする。

- 道路で囲まれたBlock polygonの抽出
- frontage基準のParcel subdivision
- 曲線Local道路 / T字路 / cul-de-sac
- 公園専用Geometry
- 学校 / 病院 / 行政 / 消防 / 警察 / 大型商業などの施設subtype
- 駅・鉄道と駅勢圏
- バス路線をDistrict / 駅 / 需要から自動生成
- Highway本線・IC・物流地区の接続強化
