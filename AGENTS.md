# City-Sim AI Development Instructions

このファイルは、City-Sim リポジトリでコード変更を行う AI / coding agent 向けのカスタム指示である。

これは仕様書ではない。機能仕様・設計の詳細は `doc/` 配下を参照すること。人間向けの標準開発手順は `doc/開発・不具合修正手順.md` にある。本ファイルは、それらを前提として AI が実際に作業するときの判断・実装・検証・報告ルールを定める。

## 1. 最優先ルール

1. 現行ソースコードを最終的な正とする。過去資料・古いコメント・ファイル名だけで実効挙動を決めつけない。
2. 作業開始前に対象コードと、その呼び出し元・後段 patch・描画/集計側まで確認する。
3. 不具合修正では症状を隠すより根本原因を直す。
4. 変更範囲は小さくするが、本来コアで直すべき問題まで無理に runtime patch に逃がさない。
5. 既存挙動を維持する部分と、意図的に変更する部分を明確に分ける。
6. TypeScript の安全性を全体で弱めない。`--noCheck`、広範囲な `@ts-nocheck`、compiler 設定の緩和で CI を通さない。
7. CI 成功と実機確認を同一視しない。描画・交通・鉄道・エージェント挙動はブラウザ上の確認が別途必要になり得る。
8. 確認していないことを「確認済み」と報告しない。
9. 複数項目の依頼では最初にチェックリスト化し、完了・未完了を最後まで追跡する。項目を黙って落とさない。
10. 1コミットごとに `src/version.ts` の `APP_VERSION` を必ず上げる。docs-only、型修正、CI修正も例外ではない。

## 2. 作業開始時

### 2.1 ブランチ

新規作業は原則として最新 `develop` から開始する。

既に作業中の feature/fix/perf branch または open PR の継続作業なら、その branch を継続してよい。継続か新規か判断できる場合は不要な確認質問をせず、Git 履歴と PR 状態から判断する。

通常の命名:

- `feat/<topic>`: 新機能
- `fix/<topic>`: 不具合修正
- `perf/<topic>`: 性能改善
- `docs/<topic>`: 独立文書作業

`main` は release 系統として扱う。通常開発で直接更新しない。

ユーザーから明示されていない限り、PRを勝手に `develop` / `main` へ merge しない。実装完了後は PR と CI 状態を提示する。

### 2.2 最初に読むもの

最低限、次を確認する。

1. `src/version.ts`
   - 現在の version
   - runtime tuning の import 順
2. 対象機能の基礎 class/module
3. 同じ責務に関係する `*Tuning.ts`, `*Fix.ts`, `*Patch.ts`
4. 呼び出し元 / update loop / renderer / Inspector / Dashboard
5. 必要なら `doc/現行仕様書.md`, `doc/詳細設計書.md`, `doc/開発・不具合修正手順.md`

City-Sim は runtime patch が多いため、基礎 class の実装だけを見て「現在の挙動」と判断してはいけない。

## 3. 新機能実装手順

### 3.1 要求を分解する

要求を次の観点へ分ける。

- 外から見える挙動
- 所有する状態・データ
- simulation 更新
- rendering / UI
- Inspector / 一覧 / 操作
- 設定値
- localStorage 等の永続化
- 性能負荷
- 既存機能との依存
- 実機で確認すべきケース

複数の要求がある場合は、実装前に内部チェックリストを作る。

### 3.2 状態の所有者を特定する

機能を追加する前に「誰が正しい値を持っているか」を決める。

例:

- Agent 状態: `AgentStore` / `World`
- 車両: `VehicleStore` / `TrafficSystem`
- バス: `BusSystem`
- タクシー: `TaxiSystem`
- POI: `POIRegistry`
- 鉄道運行: `RailRenderer` 系 runtime
- 描画位置: 実際に描画している renderer / instance transform

同じ情報を別 module で推定し直せる場合でも、可能な限り正規の source から取得する。特に位置・向き・在籍数・乗客数などを「中心位置＋推定値」で再構成しない。

### 3.3 実装方式を選ぶ

Runtime patch が向くケース:

- 既存挙動への小規模な補正
- UI / Inspector / 表示追加
- release 後の局所修正
- 回帰時に簡単に切り離して比較したい変更

コア変更が向くケース:

- class 自身の不変条件が壊れている
- 全呼び出し元へ同じ修正が必要
- hot path で wrapper が増えると無駄が大きい
- patch 同士の依存順が複雑化している
- 同じ責務に複数世代の patch が積み重なっている

### 3.4 Runtime patch の実装ルール

- install guard を置く。
- 元 method を `previous` 等で保存し wrapper chain を維持する。
- before / after のどちらで動かすかを意図的に決める。
- return 値を失わない。
- private member を触るための `Record<string, any>` は patch 境界だけに限定する。
- `src/version.ts` の import 順が実行順であることを意識する。
- 後段 patch が前段 patch を無効化していないか確認する。

標準形:

```ts
const proto = Target.prototype as unknown as Record<string, any>;
if (!proto.__citySimExamplePatchVNNN) {
  const previous = proto.method as (...args: any[]) => any;
  proto.method = function patched(this: Record<string, any>, ...args: any[]): any {
    const result = previous.apply(this, args);
    return result;
  };
  proto.__citySimExamplePatchVNNN = true;
}
```

## 4. 不具合修正手順

### 4.1 症状を固定する

可能な範囲で次を整理する。

```text
症状:
期待する挙動:
実際の挙動:
再現条件:
再現頻度:
影響範囲:
version / branch:
```

ユーザーから画像・動画・seed・時刻・対象ID・交通量などが提示されている場合は、それを再現情報として優先的に使う。

### 4.2 実効コードパスを追う

推測で怪しいファイルを修正せず、症状へ至る処理を追う。

交通の例:

```text
route/path
→ edge / lane selection
→ signal / yield
→ car-following
→ intersection transition
→ visual interpolation
```

鉄道旅客の例:

```text
trip planning
→ station access
→ route points
→ passenger state
→ visual X/Z/Y
→ renderer
```

列車描画の例:

```text
operation state
→ actual train/car pose
→ instance matrix
→ overlay / light / inspector
```

### 4.3 原因を一文で説明する

コードを書く前に、可能なら原因を一文で説明できる状態にする。

良い例:

> 交差点直進の車線減少だけ merge 許可判定から漏れており、消滅車線の車両が停止線から進入できなかった。

悪い例:

> 止まっている車を一定時間後に強制移動する。

Recovery / guard は最後の安全網として使えるが、根本原因が別にあるなら guard だけを最終修正にしない。

### 4.4 原因を持つ最小責務で直す

- lane 選択 → lane / transition
- state 遷移 → state machine
- 描画位置 → actual transform を持つ renderer
- 集計値 → 元データを持つ system
- capacity / default → config / allocation

症状が見える別 module に例外条件を足して隠すより、原因側の契約を直す。

### 4.5 反対条件を確認する

修正条件だけでなく近接する正常ケースも確認する。

例:

- 車線減少 → 同一車線数 / 車線増加 / 右左折
- visitor taxi fallback → rail/bus が使えるケース
- 曲線ホーム → 直線ホーム
- headlight → 直線 / カーブ / 逆方向 / 停車
- workforce → capacity / 住宅 / visitor headroom / performance

## 5. City-Sim 固有の不変条件

実装時は特に以下を壊さない。

- Agent / Vehicle / POI ID を途中で詰め直さない。
- TypedArray capacity を超えて spawn しない。
- reserve した POI / parking slot は失敗時に release する。
- simulation 座標と rendering 座標を混同しない。
- Agent の既存 state machine と互換な遷移を維持する。
- bus / taxi / rail の乗車状態を Dashboard 集計と矛盾させない。
- Worker / SharedArrayBuffer 側に mirror があるデータは同期方法を確認する。
- `src/version.ts` の runtime patch import 順を不用意に並べ替えない。
- 生設定値、runtime 実効値、seed 依存値を区別する。

## 6. Version / commit

コミットを1つ作るたびに `src/version.ts` の `APP_VERSION` を上げる。

例:

```text
v1.0.4 feature
v1.0.5 docs
v1.0.6 CI fix
```

コミットを追加したのに version を据え置かない。

CI失敗を修正するため追加コミットを作る場合、その修正コミットでもさらに version を上げる。

Version を上げるためだけの追加コミットを後から作らない。実際の変更と同じコミットに含める。

## 7. Build / CI

最低限、CI と同じ build が通ることを確認する。

```bash
npm ci
npm run build
```

現行 build は TypeScript compile、Vite production build、legal file copy を含む。

CI では legal distribution files も確認する。

- `dist/LICENSE`
- `dist/NOTICE`
- `dist/THIRD_PARTY_NOTICES.txt`

CIが失敗した場合:

1. failing step を確認する。
2. log の最初の実エラーを特定する。
3. 原因だけを修正する。
4. compiler / test / verification を無効化して通さない。
5. 修正コミットで version を上げる。
6. 新しい CI 結果を確認する。

## 8. 実機確認

CI が通っても以下は必要に応じて実機確認する。

### UI

- open / close
- keyboard / mouse
- search / pagination
- 保存 / 再読込
- viewport size
- 対象への jump / follow

### 車両

- spawn
- 発進
- 通常道路
- 交差点
- lane transition
- 到着
- 再 dispatch

### 鉄道

- 直線
- カーブ
- 駅進入
- 停車
- 発車
- 折返し
- 夜間照明
- passenger access

### Agent

- walk
- bus
- rail
- taxi
- destination arrival
- activity transition

### 都市生成

- seed 差
- 中心部 / 郊外
- capacity 上限
- 異常に不足・過剰な配置がないか

ブラウザ実機確認を実施できない環境では、PRと最終報告に明示する。

## 9. 性能変更

性能改善では「見た目上速くなった」だけで判断しない。

- FPS
- simulation ms
- effective sim-s/s
- lag
- worker 状態
- rail operation / visual cost
- Agent / Vehicle count

など、既存 Performance Monitor と scheduler 情報を使って比較する。

最適化で挙動を省略・頻度低下・LOD化する場合は「結果が同等か」「更新頻度だけ変わるか」を区別する。

## 10. ドキュメント更新

仕様・設計の変更は既存 `doc/` を更新する。

AI作業ルール自体を変える場合はこの `AGENTS.md` を更新する。

このファイルを `doc/README.md` の通常仕様書一覧へ混ぜない。`AGENTS.md` は仕様ではなく AI 向け実行指示として独立させる。

履歴資料 `doc/archive/` は原則更新しない。

## 11. PR

PR本文には最低限以下を書く。

- 目的
- 原因（bugfixの場合）
- 実装内容
- 重要な数値・条件変更
- version
- CI結果
- 実機確認結果
- 未確認事項
- 既知の制約

CI の status が変化したら PR 本文も古い結果のままにしない。

## 12. AI の報告ルール

ユーザーへの報告は、長い作業ログではなく判断に必要な情報を優先する。

基本構成:

1. 何を実装 / 修正したか
2. 原因または設計理由
3. branch / version / PR
4. CI結果
5. 実機確認済み / 未確認
6. 残課題

不具合修正では「直した」だけでなく、なぜ発生していたかを説明する。

実装方法を選んだ理由も短く残す。特に runtime patch を選んだ場合は、なぜコア変更より安全なのかを説明する。

## 13. 禁止するショートカット

以下を完了扱いにしない。

- エラーを無視する。
- test / build / type check を無効化する。
- 症状だけをタイマーで強制回復して根本原因を放置する。
- 実際の transform があるのに概算位置を使う。
- capacity 不足を配列外書き込みや無制限 spawn で解決する。
- 古い docs だけを根拠に現行挙動を断定する。
- CI成功だけで visual / simulation bug の修正確認済みとする。
- 未確認の項目を省略して完了報告する。
- ユーザーから依頼された複数タスクの一部を黙って落とす。

## 14. 完了条件

作業を完了と報告する前に確認する。

- [ ] 依頼項目をすべて追跡した
- [ ] 実効コードパスを確認した
- [ ] 根本原因または設計根拠を説明できる
- [ ] 変更範囲が適切
- [ ] `APP_VERSION` をコミット単位で更新した
- [ ] TypeScript/Vite build が通った
- [ ] legal-file verification が通った
- [ ] 必要な実機確認を実施した、または未実施と明記した
- [ ] PR本文が現在の実装・version・CI状態と一致している
- [ ] 未確認事項・既知制約を隠していない

このチェックを満たせない項目がある場合は、完了した部分と未完了部分を分けて報告する。
