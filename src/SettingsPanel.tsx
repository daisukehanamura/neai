import { useState } from "react";
import {
  DEFAULTS, MODELS, WAKE_PRESETS,
  type Settings as S,
} from "./settings";

interface Props {
  value: S;
  onChange: (next: S) => void;
  onClose: () => void;
  /** ウェイクワードや音響設定は、検出器を作り直さないと反映されない。 */
  onRestartNeeded: () => void;
}

export default function Settings({ value, onChange, onClose, onRestartNeeded }: Props) {
  const [dirty, setDirty] = useState(false);

  const set = <K extends keyof S>(key: K, v: S[K], needsRestart = false) => {
    onChange({ ...value, [key]: v });
    if (needsRestart) setDirty(true);
  };

  return (
    <div className="sheet" role="dialog" aria-label="設定">
      <header className="sheet-head">
        <h2>設定</h2>
        <button onClick={onClose}>閉じる</button>
      </header>

      <div className="sheet-body">
        <section>
          <h3>ウェイクワード</h3>
          <p className="hint">
            認識しやすさは「長い・子音が立っている・日常会話に出てこない」で決まる。
            すべて日本語モデルの語彙に存在することを確認済み。
          </p>
          {WAKE_PRESETS.map((p) => (
            <label key={p.id} className={`pick ${value.wakePreset === p.id ? "on" : ""}`}>
              <input
                type="radio"
                name="wake"
                checked={value.wakePreset === p.id}
                onChange={() => set("wakePreset", p.id, true)}
              />
              <span className="pick-main">{p.label}</span>
              <span className="pick-note">{p.note}</span>
            </label>
          ))}
        </section>

        <section>
          <h3>マイクの効き</h3>
          <p className="hint">
            遠くから届かないときに調整する。まずコンプレッサを試し、
            それでも足りなければゲインを上げる。
          </p>

          <label className="toggle">
            <input
              type="checkbox"
              checked={value.compressor}
              onChange={(e) => set("compressor", e.target.checked, true)}
            />
            <span>コンプレッサ<small>小さい音だけ持ち上げる。近くで喋っても割れない</small></span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={value.highpass}
              onChange={(e) => set("highpass", e.target.checked, true)}
            />
            <span>ハイパスフィルタ<small>空調や冷蔵庫の低音を切る</small></span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={value.gate}
              onChange={(e) => set("gate", e.target.checked, true)}
            />
            <span>ノイズゲート<small>静かなときは認識に回さない</small></span>
          </label>

          {value.gate && (
            <label className="slider">
              <span>しきい値 <b>{value.gateDb}</b> dBFS</span>
              <input
                type="range" min={-80} max={-30} step={1}
                value={value.gateDb}
                onChange={(e) => set("gateDb", Number(e.target.value), true)}
              />
            </label>
          )}

          <label className="slider">
            <span>入力ゲイン <b>{value.gain.toFixed(1)}</b> 倍</span>
            <input
              type="range" min={1} max={20} step={0.5}
              value={value.gain}
              onChange={(e) => set("gain", Number(e.target.value), true)}
            />
          </label>
        </section>

        <section>
          <h3>モデル</h3>
          <p className="hint">次に接続するときから反映される。</p>
          {MODELS.map((m) => (
            <label key={m.id} className={`pick ${value.model === m.id ? "on" : ""}`}>
              <input
                type="radio"
                name="model"
                checked={value.model === m.id}
                onChange={() => set("model", m.id)}
              />
              <span className="pick-main">{m.label}</span>
              <span className="pick-note">{m.note}</span>
            </label>
          ))}
        </section>

        <section>
          <h3>動作</h3>
          <label className="slider">
            <span>無操作で切断 <b>{value.idleSec}</b> 秒</span>
            <input
              type="range" min={15} max={300} step={15}
              value={value.idleSec}
              onChange={(e) => set("idleSec", Number(e.target.value))}
            />
          </label>
          <label className="slider">
            <span>回答を残す <b>{value.keepSec}</b> 秒</span>
            <input
              type="range" min={15} max={600} step={15}
              value={value.keepSec}
              onChange={(e) => set("keepSec", Number(e.target.value))}
            />
          </label>
        </section>

        <button className="reset" onClick={() => { onChange({ ...DEFAULTS }); setDirty(true); }}>
          初期値に戻す
        </button>
      </div>

      {dirty && (
        <footer className="sheet-foot">
          <p>ウェイクワードとマイクの設定は、待機し直すと反映されます。</p>
          <button className="apply" onClick={() => { setDirty(false); onRestartNeeded(); }}>
            待機し直して反映
          </button>
        </footer>
      )}
    </div>
  );
}
