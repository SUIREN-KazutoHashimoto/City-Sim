# City Generator v2 Phase 3: 特殊施設・公園

## 目的

Phase 1/2/2.5で生成したDistrict・Block・Parcel・開発強度を利用し、都市に用途上のランドマークと公共サービス拠点を与える。

Phase 3では、通常Building/POIを完全に別システムへ置き換えず、既存Simulation互換を維持したまま特殊施設へ用途転換する。

## 特殊施設

生成対象:

- 学校
- 病院
- 大学
- 市役所
- 警察署
- 消防署
- ショッピングモール
- スーパーマーケット
- ホテル
- ガソリンスタンド
- スタジアム

施設数は都市面積から需要数を算出し、施設ごとの最低間隔を設ける。

例として100km²級では、学校は住宅地へ複数分散、病院・消防・警察は数km単位で分散、市役所はCBD/Civic近傍、大型商業とホテルはCommercial/CBDを優先する。

## 配置評価

既存Buildingを候補として以下を評価する。

- District適性
- 敷地面積
- 建物幅・奥行き
- CBD/中心地への距離
- 地価
- centerInfluence
- 同種施設との距離

同じBuildingを複数施設へ使わない。

## POI差し替え

特殊施設に選ばれたBuildingの既存POIは配列から削除しない。

既存IDを保持したまま `capacity = 0` として無効化し、新しい施設POIを末尾へ追加する。

これによりParking・Agent・その他システムが保持するPOI IDを詰め直さずに済む。

POI Workerでも `occupancy >= capacity` 判定によりcapacity=0のPOIは候補外となる。

### POIマッピング

- 学校 / 大学 -> Education + Work
- 病院 -> Health + Work
- 市役所 / 警察 / 消防 -> Work
- モール -> Retail + Food + Work
- スーパー -> Retail + Work
- ホテル -> Leisure + Food + Work
- ガソリンスタンド -> Retail + Work
- スタジアム -> Leisure + Food + Work

Health / Educationは今後Agent行動を拡張するための専用カテゴリとして保持する。

## 施設の高さ補正

既存建物を用途転換するため、元Buildingの階数をそのまま使うと学校や消防署が高層化する場合がある。

Phase 3では施設タイプごとに高さレンジを補正する。

- 学校: 3～5F
- 病院: 6～12F
- 大学: 4～8F
- 市役所: 5～14F
- 警察署: 2～4F
- 消防署: 2～4F
- モール: 2～6F
- スーパー: 1～3F
- ホテル: 6～22F
- ガソリンスタンド: 1～2F
- スタジアム: 2～5F

## 公園

`DistrictType.Park` の道路で囲まれたBlockを公園として扱う。

ParkSpaceは以下を保持する。

- x / z
- width / depth
- kind
- capacity
- Leisure POI ID

kind:

- neighborhood
- civic
- city

公園自体がLeisure POIになるため、既存の娯楽行動から目的地として利用できる。

## 描画

`SpecialFacilityRenderer` を追加する。

公園:

- 緑地面
- 十字園路
- 周縁中心の樹木

特殊施設:

- 施設種別ごとの屋上アクセント
- 施設サイン
- 病院は屋上赤十字

既存Building LODはそのまま利用し、追加Geometryだけを重ねる。

## Inspector / HUD

Building Inspectorに以下を追加する。

- 施設名
- 施設定員
- 地価
- 開発強度
- 敷地面積
- 統合Parcel数
- 建ぺい率
- 容積率

HUDには特殊施設数と公園数を表示する。

## 今後

Phase 3後の候補:

1. StudentをEducation POIへ明示的に通学させる
2. Health need / 病院利用
3. 消防・警察の実サービスシミュレーション
4. 学校グラウンド、病院棟、消防車庫など施設ごとの専用Geometry
5. 鉄道・駅・駅勢圏生成（Phase 4）
