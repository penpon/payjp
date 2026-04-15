## 概要

<!-- 何を / なぜ を 3-5 行で。ビジネス価値と背景を記述 -->

## 関連 Issue / CR

<!-- Fixes #N または Change Request の番号 -->

## 変更範囲

- [ ] business logic (auth / billing / sync) — VCSDD pipeline 経由
- [ ] integration layer (HTTP / DB / frontend / E2E)
- [ ] ops / deploy / infra
- [ ] docs / tooling / CI

## 検証

- [ ] `npm test` PASS
- [ ] `node_modules/.bin/tsc --noEmit -p <該当 tsconfig>` PASS
- [ ] `npm run lint` violation なし
- [ ] 手動検証 (該当時): 手順と結果を記述

## リスク・ロールバック

<!-- 失敗時の切り戻し手順、影響範囲、想定回復時間 -->

## 仕様書同期 (該当時)

- [ ] `docs/2weeks-spec.md`
- [ ] `docs/implementation-design-mvp.md`
- [ ] `docs/tdd-acceptance-matrix-mvp.md`

## Security

- [ ] `.env*` 値・PAY.JP トークン・カード番号をコード/コミット/PR 本文に含めない
- [ ] `__Host-` cookie 属性・3DS verified・operationId 503 を弱めない
