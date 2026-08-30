#!/usr/bin/env bash
# ウェイクワード検証（spike/vosk.html）に必要なファイルを取得する。
# リポジトリには含めていない。合わせて 53MB あるため。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "vosk-browser の配布物を配置..."
mkdir -p spike/vendor
if [ ! -f node_modules/vosk-browser/dist/vosk.js ]; then
  echo "先に npm install を実行してください" >&2
  exit 1
fi
cp node_modules/vosk-browser/dist/vosk.js spike/vendor/

echo "日本語モデルを取得（約48MB）..."
mkdir -p spike/models
cd spike/models
if [ -f vosk-ja.tar.gz ]; then
  echo "すでにあります: spike/models/vosk-ja.tar.gz"
  cd ../..
  mkdir -p public/wakeword
  cp spike/models/vosk-ja.tar.gz public/wakeword/vosk-ja.tar.gz
  echo "public/wakeword/ にも配置しました"
  exit 0
fi
curl -sSL -o vosk-ja.zip https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip
unzip -qo vosk-ja.zip
DIR=$(ls -d vosk-model-*/ | head -1 | sed 's|/||')
# vosk-browser は zip ではなく tar.gz を要求する。
tar czf vosk-ja.tar.gz -C "$DIR" .
rm -rf vosk-ja.zip "$DIR"
# アプリ本体からも配信できるよう public にも置く。
cd ../..
mkdir -p public/wakeword
cp spike/models/vosk-ja.tar.gz public/wakeword/vosk-ja.tar.gz
echo "完了: spike/models/vosk-ja.tar.gz と public/wakeword/vosk-ja.tar.gz"
