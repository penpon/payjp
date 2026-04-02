# 仕様整合監査レポート（MVP向け・実装最小化優先）

## Executive Summary

暫定判定は **No-Go（Must fixの文言修正が反映されるまで）**。理由は、重点監査項目のうち **cancel復旧ページング** と **同秒 `event.created` の順序規則（複数ワーカー前提）** が、現状の仕様/設計/TDD/12.1 では「実装の最小化に必要なレベルまで明文化されておらず」、実装・テストで手戻りが起きやすい状態だからです（ただし **Must fixは全て“文言修正/判定式明文化/受け入れ追記”で閉じられる**見込みです）。

**Must fix件数:** 3件

**実装最小でGoにするための方針（3行）**  
仕様→設計→TDD→12.1の順に、まず「判定式・ページング終端・fail-close条件」を**文言で固定**して閉じる（コード提案は最後）。  
cancel復旧の候補探索は **`has_more=false` までの走査 + `offset` 上限 + 上限到達時fail-close** を明文化し、誤キャンセルを防ぐ。  
Webhookの同秒 `event.created` は「到着順」を要件にしない（複数ワーカーで非決定）ことを明文化し、**“同秒を無視しない”**期待値に収束させる。

## Findings

| ID | 重要度 | Must fix / Should fix | file:line | 問題 | 実害 | 修正案（最小） | 根拠URL | 確信度 |
|---|---|---|---|---|---|---|---|---|
| F-01 | Critical | **Must fix** | `2weeks-spec.md:482,603` / `implementation-design-mvp.md:170` / `tdd-acceptance-matrix-mvp.md:210` | **cancel復旧**（`GET /v1/customers/:id/subscriptions`）について、「ページング終端（`has_more`）、limit/offset刻み、offset上限、上限到達時fail-close」が **仕様・設計・TDD・12.1で未固定**。現状は「必要に応じてoffset」止まり。 | 実装が「1ページだけ参照」「無限ループ」「上限到達時の扱いが不明」になり得て、**誤ったsubscription採用→誤キャンセル**または **復旧不能（fail-close過多/過少）**を招く。 | 文言のみで、`limit=100`、`offset=0,100,...`、`has_more=false` まで走査、`offset<=900` 上限、上限到達時 `has_more=true` は **確定不能→fail-close** を明記。TDDと12.1にも同期待値を追記。 | PAY.JP APIは顧客subscription一覧で `limit(1~100)`/`offset` と `has_more` を返す（ページング前提）。citeturn6view0 | High |
| F-02 | High | **Must fix** | `2weeks-spec.md:482,653` / `implementation-design-mvp.md:170` / `tdd-acceptance-matrix-mvp.md:211-212` | `metadata.discord_user_id` 欠落時に使う **`current_period_end` と `members.access_end_at` の比較式**が、成果物間で粒度差があり、「UTC・丸め（秒単位化）・NULL時fail-close」を**一文で実装可能な形に統一できていない**。TDDは `floor(epoch())` 明記だが、仕様側は「Unix秒化」表現が中心。 | 秒丸め・タイムゾーンの解釈ズレで、**本来1件に確定できるのに0件扱い→fail-close**（退会復旧不能）、または（最悪）比較の誤りで **誤った1件を採用**し得る。 | 文言のみで、比較式を「`access_end_at_unix = floor(extract(epoch from members.access_end_at))`（UTC・整数秒）」と明記し、`subscription.current_period_end`（整数秒）と **完全一致**のみ採用、`access_end_at` NULLは fail-close を固定。 | subscriptionオブジェクトは `current_period_end`（整数）を返し、定期課金のサイクル/時刻はUTC基準で計算される旨が明記されている。citeturn6view0turn1view1 | High |
| F-03 | High | **Must fix** | `2weeks-spec.md:291` / `implementation-design-mvp.md:157` / `tdd-acceptance-matrix-mvp.md:295,315` | Webhookの **`event.created` 同秒**の順序規則が「到着順で処理」と明記されているが、**複数ワーカー前提**では「到着順」を要件として固定できない（DBコミット順などで非決定）。成果物がこの前提を共有しており、テスト期待値が誤解を生む。 | 実装が「到着順」を満たそうとして過剰な直列化/メモリキューを入れたり、逆に到着順を保証できず **仕様不一致**になる。さらに同秒イベントの扱いが曖昧だと、誤って `ignored` し **状態取りこぼし**が起きる。 | 文言のみで「**同秒は“無視しない”ことを要件化**し、適用順序は単一ワーカーでは到着順になり得るが、複数ワーカーでは非決定（コミット順等）と明記。TDDも「到着順保証」ではなく「`== last` を `ignored` にしない」へ期待値を寄せる。 | PAY.JP WebhookはHTTP通知であり、不達・多重送信などが起こり得るため、受信側は堅牢に扱う必要がある（順序の前提を固定しづらい）。citeturn0search2 | Med |
| F-04 | Medium | Should fix | `2weeks-spec.md:63` / `implementation-design-mvp.md:6` / `tdd-acceptance-matrix-mvp.md:6` | `deep-research-report.md` と `deepresearch.md` の表記が「説明付きで併記」されているが、文書参照の正本が一意に見えにくい（リンク切れ・参照ミスの温床）。 | ビルド/CIには直結しないが、レビュー時に「どれが正か」がブレる。 | **文言のみ**で「リポジトリ内の正本ファイル名」を1つに固定し、別名は注記に寄せる。 | （内部文書整備のため外部根拠なし） | High |

## 各指摘の修正オプション（実装コスト順）

| Finding ID | Option A: 文言修正のみ（開発コスト最小） | Option B: 最小実装変更 | Option C: 強化案（MVP後） |
|---|---|---|---|
| F-01 | **ページング仕様を“アルゴリズムとして”追記**（`limit=100`、`offset`刻み、`has_more=false`終端、`offset<=900`、上限到達時fail-close）を、仕様/設計/TDD/12.1に同一文面で入れる。**コスト:S / リスク低減:High / 推奨:A** | CLI実装に、`GET /v1/customers/:id/subscriptions` を `has_more=false` まで回すループと `offset<=900` 上限チェックを追加（fail-closeで停止・ログ）。**コスト:M / リスク低減:High** | `status` パラメータなどAPI側フィルタ活用、subscription同定のための追加監査列（例: payjp_subscription_id確実保存率の向上）や再生ツール整備。**コスト:L / リスク低減:High** |
| F-02 | 仕様側に **“比較式1行”**（UTC/整数秒/NULL時）を明記し、TDD/設計/12.1に同じ式を貼る。**コスト:S / リスク低減:Med-High / 推奨:A** | 共通ユーティリティ関数（例: `toUnixSecondsFloor(timestamptz)`）を作り、比較で必ず使用。**コスト:S-M / リスク低減:High** | 将来、DBに `access_end_at_unix` の冗長列を持つ、あるいは“秒一致だけ”でなく許容窓（±1秒）を設ける等の堅牢化（要検討）。**コスト:M-L / リスク低減:Med** |
| F-03 | 「到着順」を要件にせず、**“同秒を無視しない（`== last` を処理対象）”**へ期待値を再定義し、複数ワーカーでは順序非決定と注記。**コスト:S / リスク低減:Med / 推奨:A** | Webhook処理を `members` 行ロック等で直列化（同一会員単位）してコミット順を安定化。**コスト:M / リスク低減:High** | Event一覧API照合や再生基盤、より厳密な順序キー（PAY.JP側に順序保証があるなら採用）を検討。**コスト:L / リスク低減:High** |
| F-04 | 正本ファイル名を `deepresearch.md`（等）に統一し、別名は注釈に寄せる。**コスト:S / リスク低減:Low / 推奨:A** | （不要） | docs lint（リンク検証）等をCIに追加。**コスト:M / リスク低減:Low** |

## 整合性マトリクス

評価軸ごとに、成果物（仕様/設計/TDD/12.1）を **整合 / 軽微ズレ / 重大ズレ** で判定します。

| 観点 | 仕様（2weeks-spec） | 設計（implementation-design） | TDD（acceptance-matrix） | 12.1（2weeks-spec内） |
|---|---|---|---|---|
| cancel復旧ページング終端/上限/fail-close（重点1） | **重大ズレ**（「offsetでページング」までで、`has_more`終端・上限・fail-closeが未固定） | **重大ズレ** | **重大ズレ**（テスト期待値としてページング終端が固定されていない） | **重大ズレ**（受け入れ要件にページング終端/上限の明記が薄い） |
| `current_period_end` vs `access_end_at` 比較式（重点2） | **軽微ズレ**（UTC/Unix秒方針はあるが、比較式としての1行固定が弱い） | **軽微ズレ** | **整合**（`floor(epoch(access_end_at))` が明確） | **軽微ズレ**（受け入れ文面で比較式の“丸め”まで固定されていない） |
| `event.created` 同秒の順序規則（重点3） | **重大ズレ**（“到着順”を要件化しており、複数ワーカー前提と衝突） | **重大ズレ** | **重大ズレ**（Greenで“到着順”を期待） | **軽微ズレ**（同秒ケースが受入れ文面で明示されていない/弱い） |
| `deep-research-report.md` / `deepresearch.md` 表記（重点4） | 軽微ズレ | 軽微ズレ | 軽微ズレ | 整合（12.1の中心課題ではない） |

## 修正文案（コピペ可能）

以下は **Must fixのみ**。各項目は「Before/After」を提示します（行番号は現ファイルの読み取り結果に基づく）。

### F-01（cancel復旧ページング仕様の固定）

**対象:** `2weeks-spec.md:482`（手動再同期CLI cancel復旧の箇所）  
**Before（該当行の現状）**
```md
- 手動再同期CLIの `cancel` 不確定失敗および `payjp_subscription_id` 欠落は、...（中略）... 確定不能としてfail-closeで停止する（`member_impact_logs` 記録、`inflight_operation_*` 解除禁止）
```

**After（Before行は残し、その直後に追記）**
```md
  - ページング規則（`GET /v1/customers/:id/subscriptions`）:
    - `limit=100` 固定、`offset` は `0,100,200,...` とする。
    - レスポンスの `has_more=false` までページングして全件走査する（途中で「採用候補が2件以上」になった時点で確定不能として fail-close で停止してよい）。
    - ページング上限は `offset<=900`（最大1000件）とし、`offset=900` 到達時点で `has_more=true` の場合は確定不能として fail-close で停止する（cancel API 実行禁止、`member_impact_logs` 記録、`inflight_operation_*` 解除禁止）。
    - 通信/JSON欠落等で走査が完了できない場合も確定不能として fail-close とする。
```

**対象:** `2weeks-spec.md:603`（12.1-5 cancelの受け入れ文面）  
**Before（該当行の現状）**
```md
5. `POST /v1/subscriptions/cancel` は受付開始日前を `409` で拒否し、受付期間内の...（中略）...
```

**After（5.の末尾に追記）**
```md
。`payjp_subscription_id` 欠落時の再構築で使用する `GET /v1/customers/:id/subscriptions` は `limit=100`・`offset` ページングで `has_more=false` まで走査し、`offset<=900` 上限到達時に `has_more=true` の場合は一致件数に関わらず確定不能として fail-close で停止する（cancel API 実行禁止、`inflight_operation_*` 解除禁止）。
```

**対象:** `implementation-design-mvp.md:170`（5.4 再同期の cancel復旧の箇所）  
**Before**
```md
4. `cancel` 不確定失敗復旧および `payjp_subscription_id` 欠落時は、...（中略）...確定不能としてfail-closeで停止する（`members` 反映・解除は行わない）
```

**After（Before行の直後に追記）**
```md
   - `GET /v1/customers/:id/subscriptions` は `limit=100`、`offset=0,100,...` で `has_more=false` まで走査する。`offset<=900` 上限到達時に `has_more=true` の場合は確定不能として fail-close（反映・解除・cancel実行をしない）。
```

**対象:** `tdd-acceptance-matrix-mvp.md:200-220`（T-P0-05 cancelのRed/Green）  
**Before（抜粋）**
```md
- Red:
  - `payjp_subscription_id` 欠落時の再構築で `GET /v1/customers/:id/subscriptions` を使わず、手動判断に依存して誤ったsubscriptionを採用する
...
- Green:
  - `payjp_subscription_id` 欠落時は `GET /v1/customers/:id/subscriptions`（必要に応じてページング）で候補取得し、...
```

**After（Green側に追記。Red側にも“1ページ止まり”の失敗条件を追記）**
```md
- Red:
  - `GET /v1/customers/:id/subscriptions` のページングを先頭1ページで打ち切り、後続ページにある正しい候補を見落として誤判定する（または上限到達時の扱いがなく無限に走査する）
...
- Green:
  - `GET /v1/customers/:id/subscriptions` は `limit=100`・`offset=0,100,...` で `has_more=false` まで走査する。`offset<=900` 上限到達時に `has_more=true` の場合は確定不能として fail-close で停止する（cancel API 実行禁止、`inflight_operation_*` 解除禁止）。
```

### F-02（`current_period_end` と `access_end_at` 比較式の固定）

**対象:** `2weeks-spec.md:653`（`*_unix` 定義）  
**Before（該当行の現状）**
```md
5. `*_unix` はDBの `timestamptz` をUTCとして Unix 秒（整数）へ変換した値を指す（例: ...）。PAY.JP APIの `since/until/current_period_end` との比較・送信はUTCのUnix秒で行い、JSTはログ/運用表示のみに用いる。
```

**After（例を補強して置換）**
```md
5. `*_unix` はDBの `timestamptz` をUTCとして Unix 秒（整数）へ変換した値を指す（例: `inflight_operation_started_at_unix = floor(extract(epoch from members.inflight_operation_started_at))`、`access_end_at_unix = floor(extract(epoch from members.access_end_at))`）。PAY.JP APIの `since/until/current_period_end` との比較・送信はUTCのUnix秒（整数）で行い、JSTはログ/運用表示のみに用いる。
```

**対象:** `2weeks-spec.md:482`（cancel復旧の“metadata欠落時”の採用条件が書かれている箇所に追記）  
**After（追記する1行。metadata欠落時の分岐の直後に挿入推奨）**
```md
  - `metadata.discord_user_id` 欠落時の `current_period_end` 比較は `access_end_at_unix = floor(extract(epoch from members.access_end_at))`（UTC・整数秒）を用い、`subscription.current_period_end == access_end_at_unix` の完全一致の場合に限り採用する。`members.access_end_at` が NULL の場合は確定不能として fail-close。
```

**対象:** `implementation-design-mvp.md:170`（cancel復旧の箇所）  
**After（追記）**
```md
   - `metadata.discord_user_id` 欠落時の時刻比較は `access_end_at_unix = floor(extract(epoch from members.access_end_at))`（UTC・整数秒）を用い、`subscription.current_period_end == access_end_at_unix` の完全一致のみ採用する。`access_end_at` NULL は fail-close。
```

### F-03（同秒 `event.created` の扱い：複数ワーカー前提の明文化）

**対象:** `2weeks-spec.md:291`（Webhook共通処理 11.）  
**Before（該当行の現状）**
```md
11. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。`event.created` が同秒の場合は到着順で処理し、最終整合は日次再同期で補正する。
```

**After（置換）**
```md
11. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。`event.created == members.last_payjp_event_created_at`（同秒）の場合は **`ignored` にせず処理対象**とする。適用順序は単一ワーカーでは到着順になり得るが、複数ワーカーではDBコミット順となり得るため非決定である。最終整合は日次再同期で補正する。
```

**対象:** `implementation-design-mvp.md:157`（Webhook 9.）  
**Before**
```md
9. `event.created == members.last_payjp_event_created_at` は到着順で処理する（同秒イベントの取りこぼし防止）
```

**After（置換）**
```md
9. `event.created == members.last_payjp_event_created_at`（同秒）は `ignored` にせず処理対象とする（単一ワーカーでは到着順になり得るが、複数ワーカーではDBコミット順となり得るため順序は非決定）。
```

**対象:** `tdd-acceptance-matrix-mvp.md:295,315`（T-P0-07 の Red/Green）  
**Before**
```md
- Red:
  - 同秒 `event.created` のイベントを誤って `ignored` し、到着順処理できない
...
- Green:
  - 同秒 `event.created` は到着順で処理し、`event.created < last` のみ `ignored`
```

**After（置換）**
```md
- Red:
  - 同秒 `event.created`（`event.created == last_payjp_event_created_at`）のイベントを誤って `ignored` して取りこぼす（`<=` 判定など）
...
- Green:
  - 同秒 `event.created == last_payjp_event_created_at` は `ignored` にせず処理対象とする（順序は単一ワーカーでは到着順になり得るが、複数ワーカーでは非決定）。
  - `event.created < last` のみ `ignored`
```

## 最終判定

**Goに必要な最小変更セット（Must fixのみ）**  
F-01: cancel復旧（`GET /v1/customers/:id/subscriptions`）の **ページング終端/上限/fail-close** を、仕様・設計・TDD・12.1に同一期待値で追記（文言のみ）。  
F-02: `current_period_end` と `members.access_end_at` の比較式を **UTC・整数秒（floor）・NULL時fail-close** で1行固定し、成果物間で統一（文言のみ）。  
F-03: `event.created` 同秒は「到着順」を要件化せず、**“同秒は無視しない（`== last` を処理対象）”**へ期待値を寄せ、複数ワーカーでは順序非決定と明記（文言のみ）。

**Should fix（MVP後タスクへ分離）**  
F-04: `deep-research-report.md` / `deepresearch.md` の参照正本名を1つに統一（文言・リンク整備のみ）。