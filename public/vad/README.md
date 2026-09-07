# 声の判定（Silero VAD）の置き場

`./scripts/fetch-vad-model.sh`（= `npm run vad`）が、ここに3つ置く。
大きいのでリポジトリには入れていない。

| ファイル | 大きさ | 何か |
|---|---|---|
| `silero_vad.onnx` | 約2.3MB | Silero VAD v5。MIT |
| `ort.wasm.bundle.min.mjs` | 約68KB | ONNX Runtime Web（WASM 版） |
| `ort-wasm-simd-threaded.wasm` | 約11MB | 同上の本体 |

ONNX Runtime をバンドルに含めず、ここに置いて実行時に読んでいる。
バンドルさせると Vite が dev では WASM の場所を解決できず、本番だけ動く状態になるため。
Vosk のモデルと同じ扱いで、dev でも本番でも同じ URL を通す。

**無くてもアプリは動く。** その場合は「声の判定なし」で待機する
（設定画面の「声の判定（VAD）」が効かなくなるだけ）。

## 単体で確かめる

`npm run dev` のあと `/vad/test.html` を開く。
マイクもアプリ本体も使わずに、読み込み・推論・1フレームあたりの時間だけを見る。
`OK` が出れば実行環境としては問題ない。
