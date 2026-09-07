#!/usr/bin/env bash
# 声の判定に使う Silero VAD と、それを動かす ONNX Runtime を配信できる場所に置く。
# リポジトリには含めていない（合わせて約14MB あるため）。
#
# 無くてもアプリは動く。その場合は「声の判定なし」で、従来どおり
# ノイズゲートだけで Vosk に回すことになる（電力の削減幅が小さくなるだけ）。
#
# ONNX Runtime はバンドルに含めず、ここに置いたものを実行時に読む。
# Vosk のモデルと同じ考え方で、dev でも本番でも同じ URL を通す
# （バンドルさせると dev だけ WASM の場所を解決できない）。
set -euo pipefail
cd "$(dirname "$0")/.."

# v5。16kHz なら 512 サンプル固定で、入力は input/state/sr の3つ。
MODEL_URL="https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
# JS は WASM の読み込み部分まで含んだバンドル版。外に要るのはこの2つだけ。
ORT_DIR="node_modules/onnxruntime-web/dist"
ORT_FILES="ort.wasm.bundle.min.mjs ort-wasm-simd-threaded.wasm"

if [ ! -f "$ORT_DIR/ort.wasm.bundle.min.mjs" ]; then
  echo "先に npm install を実行してください（onnxruntime-web が必要）" >&2
  exit 1
fi

mkdir -p public/vad

echo "ONNX Runtime を配置..."
# WASM は 11MB ほどあるが、Cloudflare Workers の 1ファイル 25MiB 上限には収まる。
for f in $ORT_FILES; do cp "$ORT_DIR/$f" public/vad/; done

if [ -f public/vad/silero_vad.onnx ]; then
  echo "すでにあります: public/vad/silero_vad.onnx"
else
  echo "Silero VAD を取得（約2.3MB）..."
  curl -sSL -o public/vad/silero_vad.onnx "$MODEL_URL"
  # 404 の HTML が保存されていても拡張子は .onnx になる。大きさで気付けるようにする。
  SIZE=$(wc -c < public/vad/silero_vad.onnx | tr -d ' ')
  if [ "$SIZE" -lt 1000000 ]; then
    rm -f public/vad/silero_vad.onnx
    echo "取得に失敗しました（${SIZE}バイトしかありません）" >&2
    exit 1
  fi
fi

echo
echo "完了:"
ls -lh public/vad/ | tail -n +2 | awk '{printf "  %-24s %s\n", $9, $5}'
