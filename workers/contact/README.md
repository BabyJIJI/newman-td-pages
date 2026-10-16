# newman-contact

サイトの問い合わせフォーム（/contact/）から `/api/contact` に送られた内容を、メールで転送する Cloudflare Worker。

- Cloudflare の Workers Builds でこのリポジトリと連携し、ルートディレクトリを `workers/contact` にしてデプロイする
- 受信先はダッシュボードのシークレット `TO_ADDRESS` に登録する（Email Routing で認証済みのアドレスのみ送信可）
