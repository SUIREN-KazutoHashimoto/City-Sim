# City-Sim

TypeScript / three.js / Vite で動作するリアルタイム都市シミュレーションです。

現行標準設定では100km²・5万人規模の都市を生成し、市民、徒歩、自家用車、バス、物流、鉄道を同一シミュレーション内で扱います。

## 現行仕様

ドキュメントは [`doc/README.md`](doc/README.md) を入口にしてください。

特に現在の仕様を確認する場合は [`doc/現行仕様書.md`](doc/現行仕様書.md) を正本とします。

主な設計書:

- [`doc/現行仕様書.md`](doc/現行仕様書.md)
- [`doc/基本設計書.md`](doc/基本設計書.md)
- [`doc/機能設計書.md`](doc/機能設計書.md)
- [`doc/詳細設計書.md`](doc/詳細設計書.md)
- [`doc/設定ファイル仕様.md`](doc/設定ファイル仕様.md)
- [`doc/性能モニタ仕様.md`](doc/性能モニタ仕様.md)

`doc/CityGeneratorV2_Phase*.md` は開発履歴資料です。現行仕様と矛盾する場合は `現行仕様書.md` を優先します。

## 現行標準構成

- 都市面積: 100km²
- 人口: 50,000
- Agent capacity: 60,000
- Vehicle capacity: 30,000
- 市街地目標比率: 40%
- 鉄道幹線: 3路線
- 駅間隔基準: 525m
- 駅影響半径: 900m

実値は `public/config/city.json` を参照してください。

## 開発

```bash
npm install
npm run dev
```

ビルド:

```bash
npm run build
```

プレビュー:

```bash
npm run preview
```

## 主な現行機能

- 都市計画、道路階層、Block/Parcel、建物/POI生成
- Utility AIによる市民生活
- 徒歩、自家用車、バス、鉄道
- 道路信号・横断歩道・歩行者信号
- 店舗在庫・物流配送
- 鉄道の普通/快速/特急、閉塞、信号、ダイヤ、渡線、終端、車両基地
- 市民の実列車への乗降、ホーム待機、階段移動、1回乗換
- 駅/線路/列車照明、案内灯、駅外装
- Inspector、24時間活動グラフ、Performance Monitor
- SharedArrayBuffer / Worker / LOD / GPU Instancingによる大規模化対応

## ライセンス

City-Sim は Apache License 2.0 の下で提供します。完全なライセンス条件は `LICENSE`、帰属表示は `NOTICE` を参照してください。

Apache License 2.0 の条件を守る限り、以下を許可します。

- 商用利用
- 改変
- 再配布
- クローズドソースでの利用

再配布または派生物を配布する場合は、Apache License 2.0 が要求する著作権表示・ライセンス表示を保持し、`NOTICE` に含まれる帰属表示も同ライセンスが要求する範囲で保持してください。また、変更したファイルを配布する場合は、そのファイルを変更したことが分かる通知を付してください。

本ソフトウェアは現状有姿で提供され、明示・黙示を問わず保証はありません。利用によって生じた結果については、Apache License 2.0 に定める範囲で利用者自身が責任を負います。
