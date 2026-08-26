# City Generator v2 Phase 4 — 鉄道・駅勢圏・TOD

## 目的

Phase 4では、Phase 1〜3で作った都市構造へ鉄道を追加し、鉄道を単なる装飾ではなく都市生成へ影響する都市骨格として扱う。

実装範囲は次の通り。

1. CBDを通る都市鉄道幹線
2. 副都心へ接続する支線
3. 中央駅・副都心駅・一般駅・終端駅
4. 駅勢圏によるurbanScore / landValue / density補正
5. 駅前のDistrict用途転換
6. TODによる高密度開発・Parcel統合強化
7. 道路A*へスナップした高架鉄道
8. 駅ホーム・高架橋・簡易列車描画
9. 中央駅・副都心駅へのバスフィーダー路線

## 鉄道計画

`src/generation/RailPlanning.ts` の `RailNetworkPlan` が担当する。

都市道路を作る前に、CBDと副都心の位置から計画上の駅位置を決定する。

標準設定:

```json
{
  "railEnabled": true,
  "railTrunkLines": 2,
  "railStationSpacing": 1050,
  "railInfluenceRadius": 900,
  "railSubCenterSpurs": true
}
```

標準100km²都市では、CBDを通る2本の幹線を基本とし、副都心が幹線から離れている場合は支線を追加する。

## 駅種別

- `Central`: CBD中央駅。最大の駅勢圏を持つ。
- `SubCenter`: 副都心駅。中央駅に次ぐ駅勢圏を持つ。
- `Local`: 一般駅。
- `Terminal`: 都市外縁側の終端駅。

各駅は2種類の座標を保持する。

- `plannedX / plannedZ`: 都市生成・TOD計算用の計画位置
- `x / z`: 道路生成後にスナップした実際の高架駅位置

この分離により、都市生成結果を後処理で変えずに、鉄道描画を道路構造へ合わせられる。

## TOD（Transit Oriented Development）

`CityPlanning.sample()` は最寄り駅から `transitInfluence` を計算する。

駅の影響は距離に応じて滑らかに減衰する。

影響対象:

- `urbanScore`
- `landValue`
- `density`
- `centerInfluence`
- `DistrictType`

駅直近では市街化度・地価・密度の最低値も保証する。

### District用途転換

工業・物流・公園は基本用途を保護し、それ以外では駅勢圏の強さに応じて段階的に高密度化する。

```text
ResidentialLow
      ↓
ResidentialHigh
      ↓
MixedUse
      ↓
Commercial
```

その結果、既存のPhase 2.5開発強度モデルも駅前で強くなる。

```text
駅勢圏
  ↓
landValue / density上昇
  ↓
DevelopmentIntensity上昇
  ↓
Parcel統合率上昇
  ↓
建ぺい率/FAR上昇
  ↓
駅前商業・大型ビル・高層住宅
```

## 実線路の配置

計画鉄道は道路生成前に決まるが、描画時の線路は道路網完成後に `alignToRoadNetwork()` で調整する。

処理:

1. 各駅を最寄りのHighway/Path以外の道路Nodeへスナップ
2. 幹線道路・Collectorを優先
3. 駅間をdrive A*で接続
4. 連続する同一直線segmentを圧縮
5. 高架線として描画

道路中心線の上空へ高架を通すことで、建物を線路が貫通しにくくする。

## 鉄道描画

`src/rendering/RailRenderer.ts` が担当する。

標準高架高さは約8.2m。

描画内容:

- 高架床版
- 2本のレール
- 枕木
- 高架橋脚
- 駅ホーム
- 駅屋根
- 駅サイン
- 簡易列車

列車は路線長に応じて配置され、シミュレーション時刻に同期して終端間を往復する。

幹線列車速度は約21.5m/s、支線は約17m/sとしている。

## バス接続

`BusSystem.addRailStationFeeders()` をPhase 4で追加した。

### 中央駅・副都心駅

専用の `rail-feeder` 路線を生成する。

駅から約0.45〜2.4kmの既存停留所から、元のバス路線がなるべく重複しない2〜4停留所を選択して循環路線を作る。

```text
       既存路線A
           │
          Stop
           │
駅 ─ Stop ─┼─ Stop ─ 既存路線B
           │
          Stop
           │
       既存路線C
```

これにより既存バス網と鉄道駅の乗換点が生成される。

### 一般駅

480m以内に既存バス停がある場合、その停留所を駅の接続停留所として記録する。

## 設定

`public/config/city.json` の `planning` から変更可能。

```json
{
  "planning": {
    "railEnabled": true,
    "railTrunkLines": 2,
    "railStationSpacing": 1050,
    "railInfluenceRadius": 900,
    "railSubCenterSpurs": true
  }
}
```

### 推奨範囲

- `railTrunkLines`: 1〜3
- `railStationSpacing`: 450〜3000m
- `railInfluenceRadius`: 300〜1800m

## 現在の制約

Phase 4時点では、鉄道は都市形成・バス接続・描画を担当する。

Agentの経路探索にはまだ「列車に乗る」という状態を追加していない。

現在のAgent公共交通はバス利用までで、列車は簡易運行表示である。

次段で実際の鉄道旅客を実装する場合は、次の追加が必要。

- `ToRailStation`
- `WaitingTrain`
- `OnTrain`
- 駅間所要時間
- 鉄道経路探索
- バス→鉄道→徒歩の複合経路
- 列車定員・乗降

この部分は都市生成ではなく交通シミュレーション側の拡張として扱う。
