# City Generator v2 開発強度モデル

## 目的

地価上昇を単純な建物高さだけに反映すると、CBDに細長い高層建物が均一に並びやすい。

Phase 2.5では、`landValue` と `density` から `developmentIntensity` を生成し、以下を連動させる。

1. 隣接Parcelの統合確率
2. 建ぺい率相当の `coverageRatio`
3. 容積率相当の `floorAreaRatio`
4. 建物Footprint
5. 階数

これにより、高地価地区でも単一Parcelのペンシルビルと、複数Parcelを統合した大型再開発が混在する。

## DevelopmentIntensity

基本値は以下から計算する。

- landValue: 62%
- density: 48%
- District補正

District補正はCBD/Commercialで正、ResidentialLow/Industrial/Logistics/Parkで負とする。

値は0～1へclampする。

## Parcel consolidation

同一Block内で以下を満たす隣接Parcelだけを統合候補とする。

- 同じfrontage side
- 同じRoadClass
- 同じlane数
- 同じDistrict
- 幾何的に連続している

統合上限:

- CBD: 最大4 Parcel
- Commercial: 最大3 Parcel
- MixedUse / ResidentialHigh: 最大3 Parcel
- Civic: 最大2 Parcel
- その他: 原則1 Parcel

高いDevelopmentIntensityほど統合上限と統合確率が上がる。

ただし高地価でも統合は確率制のため、単一Parcelの細い高層建物は残る。

## Coverage Ratio

建ぺい率相当値はDistrictとDevelopmentIntensityから決める。

概念例:

- CBD: 約58～78%
- Commercial: 約54～72%
- MixedUse: 約49～66%
- ResidentialHigh: 約42～58%
- ResidentialLow: 約28～36%
- Industrial: 約48%
- Logistics: 約42%

さらにArchetypeによる補正を行う。

- DetachedHouse: 小さくする
- ResidentialTower: 基壇を少し抑える
- OfficeTower / MixedUse: 中程度
- RetailBox / CommercialBlock: 大きくする

複数Parcel統合時は再開発規模として若干大きなFootprintを許容する。

## FAR

容積率相当値もDistrict / DevelopmentIntensity / Archetypeから計算する。

概念値:

- CBD: 約380～1420%を基準
- Commercial: 約220～920%
- MixedUse: 約180～780%
- ResidentialHigh: 約120～600%
- ResidentialLow: 約45～115%

OfficeTower / ResidentialTower / MixedUseは上方補正し、SmallShop / RetailBox / DetachedHouseは下方補正する。

## 建物階数

単純な地価→階数ではなく、

`siteArea × targetFAR / effectiveFloorplate`

からFARベースの階数を求める。

RendererではTower系の上層部が基壇より細くなるため、Archetypeごとに `effectiveFloorplateFactor` を設定する。

- OfficeTower: 0.56
- ResidentialTower: 0.54
- MixedUse: 0.66
- OfficeSlab: 0.82
- MidRiseApartment: 0.84
- CommercialBlock: 0.90

従来のdensity/landValueベース階数も22%混ぜ、完全に均質なFAR生成にならないようにする。

Districtごとに最大階数も制限する。

## Building metadata

各Buildingに以下を保持する。

- `developmentIntensity`
- `coverageRatio`
- `floorAreaRatio`
- `grossFloorArea`
- `siteArea`
- `parcelCount`

またCityGeneratorは統合前の `parcels` に加えて、統合後の `developmentSites` を保持する。

これらは将来のInspector表示、地価表示、再開発シミュレーション、税収・不動産モデルに利用できる。
