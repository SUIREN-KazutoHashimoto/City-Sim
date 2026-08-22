# 性能設計追補：レンダリングLOD・シミュレーション並列化

## 1. 目的
100km²・人口5万人規模で発生したメインスレッド/GPU負荷を軽減し、都市規模を維持したまま操作性と描画FPSを改善する。

## 2. レンダリングLOD

### 2.1 距離帯
| LOD | 距離 | 方針 |
|---|---:|---|
| LOD0 | 0～1km | フル品質 |
| LOD1 | 1～3km | 簡略形状 |
| LOD2 | 3～10km | 超簡略 |
| LOD3 | 10km～ | 建物中心の遠景 |

切替には150mのヒステリシスを入れる。静的LODはカメラが100m以上移動したときだけ再構築する。

### 2.2 建物
建物を500mグリッドへ分類し、チャンク中心とカメラ距離からLODを決める。
- LOD0: Base / Upper / 窓 / 屋根 / 屋上設備 / 庇
- LOD1: Base / Upper / 窓1帯
- LOD2: 1 Box、標準マテリアル、影あり
- LOD3: 1 Box、Lambert、影なし

Inspector互換の旧Building InstancedMeshは不可視Raycast proxyとして保持する。

### 2.3 Agent
- ～1km: 頭・胴・左右脚、歩行アニメーション
- 1～3km: 単純Box
- 3km～: 個体描画なし

Inspector用Raycast proxyも3km以内だけ同期する。

### 2.4 Vehicle
- ～1km: 車体・キャビン・タイヤ・ヘッドライト・テールランプ・ウィンカー
- 1～3km: 車体のみ
- 3km～: 個体描画なし

実SpotLightは従来どおりカメラ近傍の上位8台に限定する。

### 2.5 街路ディテール
- 駐車区画線: 1km以内
- 木の幹: 1km以内
- 樹冠: 3km以内
- 街灯: 3km以内

道路本体・主要路面は遠景でも都市形状を維持するため継続描画する。

## 3. シミュレーション並列化

### 3.1 メモリ
`AgentStore` はcross-origin isolated環境でSharedArrayBufferを使用する。対象SoAは既存の全主要Agent配列で、Workerが直接同じメモリを参照する。

`vite.config.ts` のdev/previewへ以下を追加する。
- Cross-Origin-Opener-Policy: same-origin
- Cross-Origin-Embedder-Policy: require-corp

本番配信サーバーでも同等ヘッダーが必要。設定されていない場合はArrayBuffer + シングルスレッドへ自動フォールバックする。

### 3.2 Worker Pool
Worker数は `navigator.hardwareConcurrency - 2` を基準とし、最大8 Workerとする。メインスレッド・ブラウザ用CPU余力を確保する。

現段階で並列化する処理:
- Energy/Hunger/Social/Hygiene/Funの減衰
- Engaged状態の回復値計算
- 滞在終了/critical状態の判定

5万人をWorker数で連続ID範囲へ等分する。

### 3.3 バッチ実行
1描画フレーム内に発生した複数fixed stepについて、Agent独立処理は `stepDt × steps` に集約し、Workerメッセージ数を抑える。

Worker完了後、以下の依存性が強い処理は順序を維持してCoordinator側で実行する。
- UtilityBrain / 目的地予約
- A* / 旅行開始
- TrafficSystem / IDM
- BusSystem
- LogisticsSystem
- SpatialHash / 歩行者衝突回避
- POI occupancy / stockの確定更新

Workerが退館条件を検出した場合は `activityExit` フラグだけを立て、POI stock/occupancy変更はCoordinatorが一括確定する。

### 3.4 描画との非同期化
`main.ts` はSimulation batchのPromise完了を待ってrequestAnimationFrameを停止しない。SimulationがWorker計算中でも前回確定状態を使ってカメラ/UI/描画を継続する。

未処理実時間は最大0.5秒まで蓄積し、Simulation完了後に次バッチへ送る。これにより重負荷時でもUIスレッドが完全停止しにくい。

## 4. 今後の並列化候補
現在のWorker PoolはAgent独立処理を対象とする第1段階である。次の優先候補は以下。
1. A* Routing Worker Pool
2. Pedestrian更新の空間チャンク分割
3. TrafficSystemの道路チャンク分割
4. Simulation LOD（距離に応じた更新Hz低下）

Traffic/Pedestrianは隣接車両・近傍Agentへの依存があるため、単純なAgent ID分割は行わない。

## 5. HUD
HUDへ以下を表示する。
- Simulation batch処理時間
- Worker数 / SharedArrayBuffer有効状態
- 建物LOD0/1/2/3件数
- Agent LOD0/1件数
- Vehicle LOD0/1件数

これにより性能改善の効果とボトルネックを実行時に確認できる。
