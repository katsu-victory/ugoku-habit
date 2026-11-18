# うごく習慣ラボ

行動変容の技法（BCT Taxonomy v1・COM-B・実行意図・習慣形成理論）で、運動を習慣にするためのWebアプリです（PWA、日本語）。

- 安全チェック（がん治療中・術後・骨転移・リンパ浮腫など）。該当があればHIITは医療者の許可を記録するまで表示しない
- 「もし〇〇なら△△する」の if-then プラン、ミニ版、つまずき対処プラン
- 「2回続けて休まない」連続記録、達成状況に応じた段階的な目標調整、週のふり返り、習慣度（SRBAI）
- 決めた時刻の通知。通知の「やった！」「ミニ版」を押すだけで、アプリを開かずに記録
- 記録はすべて端末内（localStorage）。JSON / CSV で書き出し可

## 使い方
### A. GitHub Pages（アプリ本体だけ）
Settings → Pages → Source を「GitHub Actions」にすると、`public/` が自動で公開されます。
アプリを開いている間の通知、ホーム画面への追加、オフライン利用ができます。

### B. Cloudflare（アプリと通知サーバー、無料）
アプリを閉じていても、決めた時刻どおりに通知が届きます（iPhone はホーム画面に追加して使用）。
1. https://dash.cloudflare.com/sign-up で無料登録（カード不要）
2. Workers & Pages → Create → 「Import a repository」→ このリポジトリを選ぶ → Deploy
3. 表示された `https://ugoku-habit.〜.workers.dev` を開く

データベースは初回デプロイで自動作成され、テーブルと通知用の鍵もアプリが自動で用意します。手作業の設定は不要です。
GitHub Pages 版から通知サーバーを使う場合は、`public/index.html` の `PUSH_API` に workers.dev の URL を入れてください。

サーバーに保存するのは、通知先・曜日と時刻・きっかけの文言・最後に実施した日付だけです。運動や体調の記録は送りません。

## 構成
- `public/` … アプリ本体（index.html, sw.js, manifest）
- `src/worker.js` … 通知サーバー（毎分、各ユーザーの現地時刻で Web Push を送信）
- `src/webpush.js` … Web Push の暗号化（RFC 8291）と VAPID（RFC 8292）を WebCrypto で実装
