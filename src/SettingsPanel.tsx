import { useState } from "react";
import {
  DEFAULTS, MODELS, WAKE_PRESETS,
  type Settings as S,
} from "./settings";
import { maskedKey, setDeviceKey } from "./auth";

interface Props {
  value: S;
  onChange: (next: S) => void;
  onClose: () => void;
  /** ウェイクワードや音響設定は、検出器を作り直さないと反映されない。 */
  onRestartNeeded: () => void;
}

export default function Settings({ value, onChange, onClose, onRestartNeeded }: Props) {
  const [dirty, setDirty] = useState(false);
  const [geo, setGeo] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyLabel, setKeyLabel] = useState(() => maskedKey());

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
          <h3>ローカルコマンド</h3>
          <p className="hint">
            「タイマー三分」「今何時」などを<b>端末内で処理し、OpenAI に繋がない。</b>
            通信も課金も発生せず、返事は端末の音声合成で返す。
            認識対象が増えるぶん、ウェイクワードの精度に影響する可能性がある。
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={value.localCommands}
              onChange={(e) => set("localCommands", e.target.checked, true)}
            />
            <span>
              端末内で処理する
              <small>タイマーの設定・取消、残り時間、時刻</small>
            </span>
          </label>
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
          <h3>天気の地点</h3>
          <p className="hint">
            未設定なら東京の予報になる。一度取得すれば保存され、以後は使われる。
          </p>
          <div className="place">
            <span>
              {value.location.lat != null
                ? `${value.location.name ?? "現在地"}（${value.location.lat.toFixed(3)}, ${value.location.lon?.toFixed(3)}）`
                : "未設定（東京）"}
            </span>
            <button
              onClick={() => {
                if (!navigator.geolocation) return setGeo("この端末では取得できません");
                setGeo("取得中…");
                navigator.geolocation.getCurrentPosition(
                  (pos) => {
                    set("location", {
                      lat: pos.coords.latitude,
                      lon: pos.coords.longitude,
                      name: "現在地",
                    });
                    setGeo("");
                  },
                  (err) => setGeo(`取得できませんでした: ${err.message}`),
                  { timeout: 10000 },
                );
              }}
            >
              現在地を取得
            </button>
          </div>
          {geo && <p className="hint">{geo}</p>}
          {value.location.lat != null && (
            <button className="reset" onClick={() => set("location", {})}>
              地点をクリア
            </button>
          )}
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

        <section>
          <h3>デバイスキー</h3>
          <p className="hint">
            公開した端末を自分だけが使えるようにするためのもの。
            <b>ローカル開発では不要で、設定しなくても動く。</b>
            本番では初回に <code>#k=キー</code> 付きの URL で開けば自動で保存される。
          </p>
          <div className="place">
            <span>{keyLabel}</span>
          </div>
          {/* iOS のパスワード自動入力に邪魔されないよう text にする。
              自分の端末に自分の鍵を入れるだけなので伏せる必要もない。 */}
          <input
            type="text"
            inputMode="text"
            placeholder="鍵を貼り付けるか入力"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="row">
            <button
              className="action"
              onClick={() => {
                setDeviceKey(keyInput.trim());
                setKeyLabel(maskedKey());
                setKeyInput("");
              }}
              disabled={!keyInput.trim()}
            >
              保存
            </button>
            <button
              className="action secondary"
              onClick={() => { setDeviceKey(""); setKeyLabel(maskedKey()); }}
            >
              消す
            </button>
          </div>
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
