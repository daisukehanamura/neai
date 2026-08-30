#!/usr/bin/env bash
# ウェイクワード用の日本語モデルを取得し、配信できる形に整える。
# リポジトリには含めていない（約48MB あるため）。
set -euo pipefail
cd "$(dirname "$0")/.."

# Cloudflare Workers の静的アセットは 1ファイル 25MiB が上限。
# 48MB のモデルはそのままでは置けないので分割する。
# ローカルでも同じ経路を通るので、本番だけ動かない/壊れるということが起きない。
CHUNK_SIZE=20000000   # 20MB

echo "vosk-browser の配布物を配置..."
mkdir -p spike/vendor
if [ ! -f node_modules/vosk-browser/dist/vosk.js ]; then
  echo "先に npm install を実行してください" >&2
  exit 1
fi
cp node_modules/vosk-browser/dist/vosk.js spike/vendor/

mkdir -p spike/models public/wakeword

if [ ! -f spike/models/vosk-ja.tar.gz ]; then
  echo "日本語モデルを取得（約48MB）..."
  (
    cd spike/models
    curl -sSL -o vosk-ja.zip https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip
    unzip -qo vosk-ja.zip
    DIR=$(ls -d vosk-model-*/ | head -1 | sed 's|/||')
    # vosk-browser は zip ではなく tar.gz を要求する。
    tar czf vosk-ja.tar.gz -C "$DIR" .
    rm -rf vosk-ja.zip "$DIR"
  )
else
  echo "すでにあります: spike/models/vosk-ja.tar.gz"
fi

echo "配信用に分割..."
# 分割前の単体ファイルが public に残っていると、25MiB 上限でデプロイに失敗する。
rm -f public/wakeword/vosk-ja.tar.gz public/wakeword/vosk-ja.tar.gz.part*
split -b "$CHUNK_SIZE" spike/models/vosk-ja.tar.gz public/wakeword/vosk-ja.tar.gz.part

# 分割数と合計サイズを控えておく。クライアントはこれを見て順に取得する。
TOTAL=$(wc -c < spike/models/vosk-ja.tar.gz | tr -d ' ')
{
  printf '{\n  "bytes": %s,\n  "parts": [\n' "$TOTAL"
  FIRST=1
  for f in $(ls public/wakeword/vosk-ja.tar.gz.part* | sort); do
    [ $FIRST -eq 1 ] || printf ',\n'
    printf '    "%s"' "$(basename "$f")"
    FIRST=0
  done
  printf '\n  ]\n}\n'
} > public/wakeword/manifest.json

echo
echo "完了:"
ls -lh public/wakeword/ | tail -n +2 | awk '{printf "  %-28s %s\n", $9, $5}'
echo
echo "  合計 $(ls public/wakeword/vosk-ja.tar.gz.part* | wc -l | tr -d ' ') 分割 / $((TOTAL / 1000000))MB"
echo "  1ファイルあたり 25MiB 未満であることを確認してください（Workers の上限）"
