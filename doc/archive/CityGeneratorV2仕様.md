# City Generator v2 仕様（Phase 1 / Phase 2）

## 目的

従来の「Noiseで市街地判定 → 均一グリッド道路 → 各90mセル内で建物を格子分割」から、都市計画と道路接道を先に決める方式へ移行する。

現在の生成順序は以下。

1. City Planning
2. CBD / 副都心 / 工業・物流拠点
3. District / 地価 / 密度
4. 道路階層
5. 地区別の道路密度
6. 道路Edgeを基準グリッド境界へRasterize
7. 道路で分断された市街地セルからUrban Blockを抽出
8. Block外周道路に沿ってParcel subdivision
9. Parcel frontage / setbackに基づきBuilding / Parkingを配置
10. POI登録
11. Gate / バス / 物流（既存システムへ接続）

---

## Phase 1: City Planning

### District

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

### 市街化度・地価・密度

以下は別の値として扱う。

- `urbanScore`: 市街地として採用するか
- `landValue`: 地価
- `density`: 建物密度・高さの基準

`urbanRatioTarget` はサンプリングした `urbanScore` の分位点から閾値を校正する。

地価はCBD/副都心への近さを強く評価し、Industrial / Logisticsでは低下させる。建物階数は `density` と `landValue` の組み合わせから決定するため、「市街地だが低層の工業地」と「高地価・高密度のCBD」を分離できる。

### 道路階層

既存互換のためRoadClassの既存数値は維持し、Collectorを追加する。

生成上の階層:

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

道路グラフ自体は既存A* / Sidewalk / Traffic / Busとの互換性を維持するため、基準グリッドを下地にする。

### 信号

原則としてArterial/Collector同士の交差点へ設置する。CBDではArterialとLocalの一部交差点にも設置する。

---

## Phase 2: Block / Parcel

### Block抽出

Phase 1までは道路を間引いても、建物生成は90m基準セルごとに独立していた。

Phase 2では `BlockParcelLayout` を追加し、生成済みRoadNetworkから道路境界を復元する。

処理:

1. RoadEdgeを基準グリッド上の縦/横境界へRasterize
2. 道路が存在する境界はセル間を分断する
3. 道路が存在しない境界だけ隣接市街地セルをFlood Fillで結合する
4. 結合領域を矩形Blockへ分解する
5. 各Block外周について接道道路クラス・車線数・coverageを求める

これにより、例えば以下のようになる。

- CBD: 約1×1セルBlock
- ResidentialLow: 約2×2セルBlock
- Industrial / Logistics: 約3×3セル級Block

District境界や道路の途切れでは不定形の結合領域ができるため、現段階では矩形へ分解して扱う。

### Frontage

各Blockは最大4方向の接道情報を持つ。

- north
- south
- west
- east

各frontageには以下を保持する。

- `roadClass`
- `lanes`
- `coverage`

RoadClassのenum数値は階層順ではないため、道路優先度は明示rankで評価する。

`Highway > Arterial > Collector > Local > Path`

### Parcel subdivision

Blockの道路側外周を帯状に分割してParcelを作る。

標準frontage幅の目安:

- CBD: 21m
- Commercial: 25m
- MixedUse: 25m
- ResidentialHigh: 27m
- ResidentialLow: 36m
- Industrial: 68m
- Logistics: 92m
- Civic: 48m
- Park: 80m

Parcel奥行きもDistrict別に変える。

小街区で一方向のParcelが街区を占有し過ぎないよう、外周stripの奥行きはBlock有効寸法の最大32%に制限する。

北/南側Parcelを先に配置し、東/西側Parcelは角部の重複を避けて残り区間へ配置する。

Parcelは `CityGenerator.parcels`、Blockは `CityGenerator.blocks` として保持する。

### 道路幅による建築可能領域

Parcel生成時に道路中心線から以下を除外する。

`roadWidth(lanes) / 2 + sidewalk margin`

これによりArterial沿いで建物が車道へ食い込むことを防ぐ。

### Building setback

建物はParcel中央へランダム配置せず、frontage側を基準に配置する。

例:

- CBD / Commercial: 前面setbackを小さくする
- MixedUse: 小さめ
- ResidentialHigh: 中程度
- ResidentialLow / DetachedHouse: 前庭を大きくする
- Factory / Warehouse: 大きな前面setbackを取り、ヤード相当の空間を残す

rear / side setbackもDistrict・Archetype別に持つ。

結果として街区中心には以下のような未建築空間が残る。

- 裏庭
- 中庭
- 搬入ヤード
- 空地
- 将来の施設配置領域

### Building frontage metadata

`Building` に `frontage` を追加する。

現在の道路は直交グリッド基盤なので、Buildingの `width/depth` はRenderer/Inspector互換のためworld-space寸法へ畳み込む。frontage方向自体は別metadataとして保持する。

将来、任意角度道路へ移行した際は `frontage` と道路接線から実rotationを生成する。

### 駐車場

駐車場も基準セルの固定正方形ではなく、Parcelの矩形サイズから生成する。

- CBD: 少ない
- Commercial / MixedUse: 中程度
- ResidentialLow: 多め
- Industrial: 多め
- Logistics: 最多
- Park: 原則なし

駐車スロットは矩形lot内へ約3.0m × 5.4m単位で生成する。

同一Block内では基本1つまでとし、建物配置済みParcelへ後から駐車場を重ねるfallbackは使用しない。

---

## 建物用途

建物用途はDistrictとParcelの接道道路クラスの両方から決定する。

例:

- CBD: Work / Retail / Food / MixedUseを多くする
- Commercial: Retail / Food / Work中心
- ResidentialHigh: Home中心だが幹線沿いはRetail / Food増加
- ResidentialLow: Home中心。Arterial沿いだけ沿道商業を増やす
- Industrial: Work中心
- Logistics: Work中心
- Park: 原則空地。低確率でLeisure施設のみ

### Building Archetype

Phase 1で以下を追加済み。

- Factory
- Warehouse

Phase 2では大Parcel・setback・矩形駐車場により、工業/物流地区の敷地構成も住宅/商業地区と分離する。

---

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

Parcel寸法・setbackはPhase 2時点ではDistrictごとの内部既定値。

---

## Phase 3候補

Phase 2時点では道路は直交基準グリッドを下地としている。Blockも任意polygonではなく矩形分解で扱う。

次段階では以下を候補とする。

- School / Hospital / University / CityHall / Police / FireStation
- Mall / Supermarket / Hotel / GasStation / Stadium
- Park専用Geometry / Plaza / SchoolGround
- Parcel内のyard / garden / loading bayの明示Geometry
- District / ParcelをInspectorで確認するDebug overlay
- 駅・鉄道と駅勢圏
- バス路線をDistrict / 駅 / 需要から自動生成

その後の道路生成拡張候補:

- 一般polygon Block抽出
- 曲線Local道路
- T字路
- cul-de-sac
- 任意角度道路に対する建物rotation
- Highway本線 / IC / 物流地区接続強化
