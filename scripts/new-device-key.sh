#!/usr/bin/env bash
# 本番用のデバイスキーを作る。
# 公開した端末を自分だけが使えるようにするためのもの。
set -euo pipefail

# /dev/urandom を head で打ち切ると SIGPIPE で pipefail に引っかかるため、
# 先に固定長を読んでから絞る。
KEY=$(head -c 96 /dev/urandom | LC_ALL=C base64 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-48)

cat <<MSG
生成したデバイスキー（この画面を閉じる前に控えてください）

  $KEY

次の手順で使います。

  1. Worker に登録する
       npx wrangler secret put DEVICE_KEY
     と実行し、聞かれたら上のキーを貼り付ける

  2. iPhone で初回だけ次の URL を開く
       https://<あなたのWorker>.workers.dev/#k=$KEY

     開くと端末に保存され、URL からは自動で消えます。
     以後は普通に https://<あなたのWorker>.workers.dev/ を開けば使えます。

  3. 設定画面の「デバイスキー」で保存されたことを確認できます

注意
  - このキーが漏れると、他人があなたの課金で AI と会話できます
  - ローカル開発では不要です。.dev.vars に入れないでください
MSG
