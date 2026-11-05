'use strict';

// =====================================================
// AudioClipper - ブラウザ上でWAVファイルを切り取り編集するツール
// =====================================================

// ---------- DOM要素の取得 ----------
const dropZone = document.getElementById('dropZone');
const dropText = document.getElementById('dropText');
const fileInput = document.getElementById('fileInput');
const waveWrap = document.getElementById('waveWrap');
const waveCanvas = document.getElementById('waveCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const infoBox = document.getElementById('info');
const controls = document.getElementById('controls');
const helpText = document.getElementById('help');
const totalTimeEl = document.getElementById('totalTime');
const cursorTimeEl = document.getElementById('cursorTime');
const selTimeEl = document.getElementById('selTime');
const playBtn = document.getElementById('playBtn');
const deleteBtn = document.getElementById('deleteBtn');
const cropBtn = document.getElementById('cropBtn');
const undoBtn = document.getElementById('undoBtn');
const exportFormatSel = document.getElementById('exportFormat');
const bitrateLabel = document.getElementById('bitrateLabel');
const bitrateSel = document.getElementById('bitrate');
const exportBtn = document.getElementById('exportBtn');
const volumeSlider = document.getElementById('volume');
const volumeValueEl = document.getElementById('volumeValue');

const waveCtx = waveCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

// ---------- アプリの状態 ----------
const state = {
  buffer: null,      // 編集中のAudioBuffer
  fileName: '',      // 読み込んだファイル名（エクスポート時の名前に使う）
  selection: null,   // 選択範囲 { start, end }（サンプル単位）
  cursor: 0,         // 再生開始位置（サンプル単位）
  history: [],       // 元に戻す用の履歴
};

// 履歴の最大保存数（メモリ節約のため）
const MAX_HISTORY = 20;

// 波形描画の色（テーマに応じて style.css の CSS 変数から読み込む）
const COLORS = {};

// 現在のテーマの描画色を CSS 変数から取得する
function loadColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  COLORS.wave = get('--wave');
  COLORS.centerLine = get('--wave-center');
  COLORS.grid = get('--wave-grid');
  COLORS.gridText = get('--wave-grid-text');
  COLORS.selection = get('--wave-selection');
  COLORS.selectionEdge = get('--wave-selection-edge');
  COLORS.cursor = get('--wave-cursor');
  COLORS.playhead = get('--wave-playhead');
}
loadColors();

// テーマが切り替わったら描画色を読み直して波形を描き直す（theme.js から通知される）
document.addEventListener('themechange', () => {
  loadColors();
  if (!state.buffer) return;
  drawWaveform();
  // 再生中は次のフレームで再生位置ごと描画されるため、停止中のみ上層を描き直す
  if (!sourceNode) drawOverlay();
});

// ---------- 再生関連の状態 ----------
let audioCtx = null;       // 再生用のAudioContext（初回操作時に生成）
let gainNode = null;       // 再生音量を調整するノード（再生音のみに適用）
let sourceNode = null;     // 再生中のノード
let playToken = 0;         // 停止判定用の識別子
let playStartCtxTime = 0;  // 再生開始時のAudioContext時刻
let playStartSample = 0;   // 再生を開始したサンプル位置
let playEndSample = 0;     // 再生を終了するサンプル位置
let animationId = 0;       // 再生位置アニメーションのID

// ---------- マウス操作関連の状態 ----------
let dragging = false;      // ドラッグ中かどうか
let dragAnchor = 0;        // ドラッグを開始したサンプル位置
let dragStartX = 0;        // ドラッグを開始したX座標（クリック判定用）
let dragMoved = false;     // 一定距離以上動いたか

// 波形のピーク値キャッシュ（キャンバス幅ごとに再計算）
let peaksCache = null;

// 読み込みに対応する拡張子（デコードはブラウザ標準機能で行う）
const SUPPORTED_EXT = /\.(wav|mp3|ogg|oga|opus|flac|m4a)$/i;

// ドロップエリアの初期メッセージ
const DEFAULT_DROP_TEXT = dropText.textContent;

// =====================================================
// ファイル読み込み
// =====================================================

// クリックでファイル選択したとき
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) loadFile(fileInput.files[0]);
  fileInput.value = ''; // 同じファイルを再選択できるようにリセット
});

// ドラッグ&ドロップでファイルを受け取る
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) loadFile(e.dataTransfer.files[0]);
});

// ファイルを読み込んでAudioBufferに変換する
async function loadFile(file) {
  // 拡張子で対応形式かどうかを確認
  if (!SUPPORTED_EXT.test(file.name)) {
    alert('対応していないファイル形式です（WAV / MP3 / OGG / FLAC / M4A に対応）。');
    return;
  }

  stopPlayback();
  dropText.textContent = `読み込み中: ${file.name} ...`;

  try {
    const arrayBuffer = await file.arrayBuffer();

    // WAVの場合のみヘッダから元のサンプルレート・ビット深度を取得
    // （それ以外の形式はブラウザ既定のサンプルレートでデコードされる）
    const info = /\.wav$/i.test(file.name) ? parseWavHeader(arrayBuffer) : null;

    // デコードする（WAVは元のサンプルレートのまま）
    const buffer = await decodeAudio(arrayBuffer, info);

    // 状態を初期化
    state.buffer = buffer;
    state.fileName = file.name;
    state.selection = null;
    state.cursor = 0;
    state.history = [];

    // エクスポート形式の初期値を元ファイルに合わせる
    exportFormatSel.value = defaultExportFormat(file.name, info);
    updateBitrateVisibility();

    // 編集用のUIを表示
    waveWrap.hidden = false;
    infoBox.hidden = false;
    controls.hidden = false;
    helpText.hidden = false;
    const bitText = info ? ` / ${info.bitsPerSample}bit` : '';
    dropText.textContent = `${file.name} (${buffer.sampleRate} Hz / ${buffer.numberOfChannels}ch${bitText})`;

    resizeCanvases();
    updateUI();
  } catch (err) {
    console.error(err);
    alert('ファイルの読み込みに失敗しました（ブラウザがこの形式・コーデックに対応していない可能性があります）: ' + err.message);
    dropText.textContent = DEFAULT_DROP_TEXT;
  }
}

// WAVファイルのヘッダ（fmtチャンク）を解析する
function parseWavHeader(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const readStr = (offset, len) =>
    String.fromCharCode(...new Uint8Array(arrayBuffer, offset, len));

  // 先頭が "RIFF" ... "WAVE" であるか確認
  if (arrayBuffer.byteLength < 12 || readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('WAV形式ではありません');
  }

  // チャンクを順に読み、fmtチャンクを探す
  let offset = 12;
  while (offset + 8 <= arrayBuffer.byteLength) {
    const id = readStr(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      let format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const bitsPerSample = view.getUint16(offset + 22, true);
      // WAVE_FORMAT_EXTENSIBLE の場合は実際のフォーマットをサブフォーマットから取得
      if (format === 0xFFFE && size >= 26) {
        format = view.getUint16(offset + 8 + 24, true);
      }
      return { channels, sampleRate, bitsPerSample, isFloat: format === 3 };
    }
    // チャンクサイズが奇数の場合はパディング1バイトを飛ばす
    offset += 8 + size + (size % 2);
  }
  throw new Error('fmtチャンクが見つかりません');
}

// 音声データをデコードする（info が null の場合はWAV以外の形式）
async function decodeAudio(arrayBuffer, info) {
  // WAV以外はブラウザ標準のデコーダでそのままデコード
  if (!info) {
    return await getAudioContext().decodeAudioData(arrayBuffer);
  }
  try {
    // 元ファイルと同じサンプルレートのOfflineAudioContextでデコード
    const ctx = new OfflineAudioContext(Math.max(1, info.channels), 1, info.sampleRate);
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    // 非対応のサンプルレートなどで失敗した場合は通常のAudioContextでデコード
    console.warn('元のサンプルレートでのデコードに失敗したため、既定のレートでデコードします', e);
    return await getAudioContext().decodeAudioData(arrayBuffer.slice(0));
  }
}

// =====================================================
// 波形の描画
// =====================================================

// キャンバスのサイズを表示サイズ（と画面の解像度）に合わせる
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(waveWrap.clientWidth * dpr));
  const h = Math.max(1, Math.floor(waveWrap.clientHeight * dpr));
  for (const c of [waveCanvas, overlayCanvas]) {
    c.width = w;
    c.height = h;
  }
  peaksCache = null;
  drawWaveform();
  drawOverlay();
}

// 表示領域のサイズが変わったら再描画する
new ResizeObserver(() => {
  if (state.buffer) resizeCanvases();
}).observe(waveWrap);

// 横1ピクセルごとの最小値・最大値（ピーク）を計算する
function computePeaks(buffer, width) {
  const peaks = [];
  const len = buffer.length;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    const min = new Float32Array(width);
    const max = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      // このピクセルに対応するサンプル範囲
      const from = Math.floor((x * len) / width);
      const to = Math.max(from + 1, Math.floor(((x + 1) * len) / width));
      let lo = 1, hi = -1;
      for (let i = from; i < to && i < len; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[x] = lo;
      max[x] = hi;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

// 波形とタイムグリッドを描画する（下層キャンバス）
function drawWaveform() {
  const { width: W, height: H } = waveCanvas;
  waveCtx.clearRect(0, 0, W, H);
  const buffer = state.buffer;
  if (!buffer) return;

  const dpr = window.devicePixelRatio || 1;
  drawTimeGrid(W, H, dpr);

  // ピーク値はキャッシュがなければ計算する
  if (!peaksCache) peaksCache = computePeaks(buffer, W);

  // チャンネルごとに縦方向のレーンを分けて描画
  const channels = buffer.numberOfChannels;
  const laneH = H / channels;
  for (let ch = 0; ch < channels; ch++) {
    const { min, max } = peaksCache[ch];
    const mid = laneH * ch + laneH / 2;
    const amp = laneH / 2 * 0.9;

    // 中心線
    waveCtx.fillStyle = COLORS.centerLine;
    waveCtx.fillRect(0, Math.round(mid), W, 1);

    // 各ピクセル列に縦線を描いて波形を表現
    waveCtx.fillStyle = COLORS.wave;
    for (let x = 0; x < W; x++) {
      const top = mid - max[x] * amp;
      const bottom = mid - min[x] * amp;
      waveCtx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }
}

// 時間の目盛りを描画する
function drawTimeGrid(W, H, dpr) {
  const duration = state.buffer.duration;
  // 目盛り間隔の候補から、約90px以上の間隔になるものを選ぶ
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const minGapPx = 90 * dpr;
  const step = steps.find((s) => (s / duration) * W >= minGapPx) || steps[steps.length - 1];

  waveCtx.fillStyle = COLORS.grid;
  waveCtx.font = `${11 * dpr}px system-ui, sans-serif`;
  waveCtx.textBaseline = 'top';
  for (let t = 0; t <= duration; t += step) {
    const x = Math.round((t / duration) * W);
    waveCtx.fillStyle = COLORS.grid;
    waveCtx.fillRect(x, 0, 1, H);
    waveCtx.fillStyle = COLORS.gridText;
    waveCtx.fillText(formatTime(t, step < 1), x + 4 * dpr, 4 * dpr);
  }
}

// 選択範囲・カーソル・再生位置を描画する（上層キャンバス）
function drawOverlay(playheadSample = null) {
  const { width: W, height: H } = overlayCanvas;
  overlayCtx.clearRect(0, 0, W, H);
  if (!state.buffer) return;
  const dpr = window.devicePixelRatio || 1;

  // 選択範囲（削除対象）を半透明の赤で表示
  if (state.selection) {
    const x1 = sampleToX(state.selection.start);
    const x2 = sampleToX(state.selection.end);
    overlayCtx.fillStyle = COLORS.selection;
    overlayCtx.fillRect(x1, 0, x2 - x1, H);
    overlayCtx.fillStyle = COLORS.selectionEdge;
    overlayCtx.fillRect(x1, 0, dpr, H);
    overlayCtx.fillRect(x2 - dpr, 0, dpr, H);
  } else {
    // 選択がないときは再生開始位置（カーソル）を表示
    overlayCtx.fillStyle = COLORS.cursor;
    overlayCtx.fillRect(sampleToX(state.cursor), 0, Math.max(1, dpr), H);
  }

  // 再生中は再生位置を表示
  if (playheadSample !== null) {
    overlayCtx.fillStyle = COLORS.playhead;
    overlayCtx.fillRect(sampleToX(playheadSample), 0, Math.max(1, 2 * dpr), H);
  }
}

// サンプル位置 → キャンバスのX座標
function sampleToX(sample) {
  return Math.round((sample / state.buffer.length) * overlayCanvas.width);
}

// マウスイベントの位置 → サンプル位置
function eventToSample(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return Math.round(ratio * state.buffer.length);
}

// =====================================================
// ドラッグによる範囲選択
// =====================================================

overlayCanvas.addEventListener('pointerdown', (e) => {
  if (!state.buffer || e.button !== 0) return;
  stopPlayback();
  overlayCanvas.setPointerCapture(e.pointerId);
  const sample = eventToSample(e);

  if (e.shiftKey) {
    // Shift+クリック：現在の選択範囲（またはカーソル）からクリック位置まで拡張
    const base = state.selection
      ? (Math.abs(sample - state.selection.start) > Math.abs(sample - state.selection.end)
          ? state.selection.start : state.selection.end)
      : state.cursor;
    dragAnchor = base;
    dragMoved = true;
    setSelection(base, sample);
  } else {
    dragAnchor = sample;
    dragMoved = false;
  }
  dragStartX = e.clientX;
  dragging = true;
});

overlayCanvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // 数ピクセル以上動いたらドラッグ（範囲選択）とみなす
  if (!dragMoved && Math.abs(e.clientX - dragStartX) < 3) return;
  dragMoved = true;
  setSelection(dragAnchor, eventToSample(e));
});

overlayCanvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (!dragMoved) {
    // ほぼ動いていなければクリック：選択を解除してカーソル位置を設定
    state.selection = null;
    state.cursor = eventToSample(e);
    updateUI();
  }
});

// 選択範囲を設定する（開始・終了の大小は自動で整える）
function setSelection(a, b) {
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  state.selection = end > start ? { start, end } : null;
  state.cursor = start;
  updateUI();
}

// =====================================================
// 編集操作（削除・トリミング・元に戻す）
// =====================================================

// 現在の状態を履歴に保存する
function pushHistory() {
  state.history.push({
    buffer: state.buffer,
    selection: state.selection,
    cursor: state.cursor,
  });
  if (state.history.length > MAX_HISTORY) state.history.shift();
}

// 指定範囲を取り除いた新しいAudioBufferを作る
function removeRange(buffer, start, end) {
  const newLength = buffer.length - (end - start);
  const result = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: newLength,
    sampleRate: buffer.sampleRate,
  });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = result.getChannelData(ch);
    dst.set(src.subarray(0, start), 0);   // 選択範囲より前
    dst.set(src.subarray(end), start);    // 選択範囲より後ろ
  }
  return result;
}

// 指定範囲だけを切り出した新しいAudioBufferを作る
function extractRange(buffer, start, end) {
  const result = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: end - start,
    sampleRate: buffer.sampleRate,
  });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    result.getChannelData(ch).set(buffer.getChannelData(ch).subarray(start, end));
  }
  return result;
}

// 選択範囲を削除する
function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  // 全体を選択して削除すると空になるため防止
  if (sel.end - sel.start >= state.buffer.length) {
    alert('全体を削除することはできません。');
    return;
  }
  stopPlayback();
  pushHistory();
  state.buffer = removeRange(state.buffer, sel.start, sel.end);
  state.selection = null;
  state.cursor = sel.start; // 削除した位置にカーソルを置く
  onBufferChanged();
}

// 選択範囲以外を削除する（トリミング）
function cropSelection() {
  const sel = state.selection;
  if (!sel) return;
  stopPlayback();
  pushHistory();
  state.buffer = extractRange(state.buffer, sel.start, sel.end);
  state.selection = null;
  state.cursor = 0;
  onBufferChanged();
}

// 直前の編集を取り消す
function undo() {
  const prev = state.history.pop();
  if (!prev) return;
  stopPlayback();
  state.buffer = prev.buffer;
  state.selection = prev.selection;
  state.cursor = prev.cursor;
  onBufferChanged();
}

// オーディオデータが変わったときに波形を描き直す
function onBufferChanged() {
  peaksCache = null;
  drawWaveform();
  updateUI();
}

// =====================================================
// 再生
// =====================================================

// AudioContextを取得（なければ作成）
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    // 再生音は「音源 → 音量調整 → スピーカー」の順に流す
    gainNode = audioCtx.createGain();
    gainNode.gain.value = getVolume();
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

// スライダーの値（0〜200%）を音量の倍率（0〜2.0）に変換する
function getVolume() {
  return Number(volumeSlider.value) / 100;
}

// 音量スライダーの表示と再生音量を更新する
function applyVolume() {
  volumeValueEl.textContent = `${volumeSlider.value}%`;
  // 再生中でも即座に反映（急な変化によるプチノイズを防ぐため短時間でなめらかに変化させる）
  if (gainNode) gainNode.gain.setTargetAtTime(getVolume(), audioCtx.currentTime, 0.01);
  // 次回起動時も同じ音量になるよう保存（保存できない環境では無視）
  try { localStorage.setItem('audioClipper.volume', volumeSlider.value); } catch (_) { /* 無視 */ }
}

// 前回保存した音量を復元する
try {
  const saved = localStorage.getItem('audioClipper.volume');
  if (saved !== null && !Number.isNaN(Number(saved))) volumeSlider.value = saved;
} catch (_) { /* 保存領域が使えない場合は初期値のまま */ }
volumeValueEl.textContent = `${volumeSlider.value}%`;

// スライダー操作で音量を変更
volumeSlider.addEventListener('input', applyVolume);
// 操作が終わったらフォーカスを外す（スペースキー等のショートカットを引き続き使えるように）
volumeSlider.addEventListener('change', () => volumeSlider.blur());
// ダブルクリックで100%に戻す
volumeSlider.addEventListener('dblclick', () => {
  volumeSlider.value = 100;
  applyVolume();
});

// 再生・停止を切り替える
function togglePlay() {
  if (sourceNode) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

// 再生を開始する（選択範囲があればその範囲、なければカーソル位置から最後まで）
function startPlayback() {
  const buffer = state.buffer;
  if (!buffer) return;
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  let start = state.selection ? state.selection.start : state.cursor;
  const end = state.selection ? state.selection.end : buffer.length;
  // カーソルが末尾にある場合は先頭から再生
  if (start >= end) start = 0;

  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(gainNode); // 音量調整ノードを経由して出力
  node.start(0, start / buffer.sampleRate, (end - start) / buffer.sampleRate);

  // 再生終了時の処理（停止ボタンで止めた場合は別の識別子になるため無視される）
  const token = ++playToken;
  node.onended = () => {
    if (token === playToken) finishPlayback();
  };

  sourceNode = node;
  playStartCtxTime = ctx.currentTime;
  playStartSample = start;
  playEndSample = end;
  playBtn.textContent = '■ 停止';
  animatePlayhead();
}

// 再生を停止する
function stopPlayback() {
  if (!sourceNode) return;
  playToken++; // onendedで二重処理しないよう識別子を更新
  try { sourceNode.stop(); } catch (_) { /* 既に停止済み */ }
  finishPlayback();
}

// 再生終了後の後片付け
function finishPlayback() {
  if (sourceNode) sourceNode.disconnect();
  sourceNode = null;
  cancelAnimationFrame(animationId);
  playBtn.textContent = '▶ 再生';
  drawOverlay();
}

// 再生位置を毎フレーム描画する
function animatePlayhead() {
  if (!sourceNode) return;
  const elapsed = audioCtx.currentTime - playStartCtxTime;
  const pos = Math.min(playEndSample, playStartSample + Math.round(elapsed * state.buffer.sampleRate));
  drawOverlay(pos);
  cursorTimeEl.textContent = formatTime(pos / state.buffer.sampleRate);
  animationId = requestAnimationFrame(animatePlayhead);
}

// =====================================================
// エクスポート（WAV / OGG / M4A）
// =====================================================

// ※ 各形式のエンコード処理は encoders.js にまとめている

// 読み込んだファイルに合わせて書き出し形式の初期値を決める
function defaultExportFormat(fileName, wavInfo) {
  const isAvailable = (value) => !exportFormatSel.querySelector(`option[value="${value}"]`).disabled;
  if (wavInfo) {
    // WAVは元のビット深度に合わせる
    return wavInfo.isFloat ? 'wav32' : (wavInfo.bitsPerSample === 24 ? 'wav24' : 'wav16');
  }
  // OGG・M4Aは同じ形式（ブラウザが対応している場合）、それ以外はWAV 16bit
  if (/\.(ogg|oga|opus)$/i.test(fileName) && isAvailable('ogg')) return 'ogg';
  if (/\.m4a$/i.test(fileName) && isAvailable('m4a')) return 'm4a';
  return 'wav16';
}

// 圧縮形式のときだけビットレートの選択を表示する
function updateBitrateVisibility() {
  bitrateLabel.hidden = !CODEC_CONFIGS[exportFormatSel.value];
}
exportFormatSel.addEventListener('change', updateBitrateVisibility);

// ブラウザが対応していない圧縮形式は選べないようにする
async function checkExportSupport() {
  for (const format of Object.keys(CODEC_CONFIGS)) {
    if (!(await isFormatSupported(format))) {
      const option = exportFormatSel.querySelector(`option[value="${format}"]`);
      option.disabled = true;
      option.textContent += '（このブラウザは非対応）';
    }
  }
}
checkExportSupport();

// 編集後のオーディオを選択した形式でダウンロードする
async function exportAudio() {
  if (!state.buffer) return;
  const format = exportFormatSel.value;
  const bitrate = Number(bitrateSel.value);

  // 書き出し中はボタンを押せないようにする
  exportBtn.disabled = true;
  exportBtn.textContent = '書き出し中…';
  try {
    const blob = await encodeAudio(state.buffer, format, bitrate);

    // 元のファイル名（拡張子を除く）に「_edited」と新しい拡張子を付けて保存
    const baseName = state.fileName.replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName}_edited.${EXPORT_EXT[format]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // ダウンロード開始後にURLを解放
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    console.error(err);
    alert('書き出しに失敗しました: ' + err.message);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'エクスポート';
  }
}

// =====================================================
// UI更新・ボタン・キーボード操作
// =====================================================

// 時間表示とボタンの有効/無効を更新する
function updateUI() {
  const buffer = state.buffer;
  if (!buffer) return;
  const sr = buffer.sampleRate;
  totalTimeEl.textContent = formatTime(buffer.duration);
  cursorTimeEl.textContent = formatTime(state.cursor / sr);

  if (state.selection) {
    const { start, end } = state.selection;
    selTimeEl.textContent =
      `${formatTime(start / sr)} 〜 ${formatTime(end / sr)}（${formatTime((end - start) / sr)}）`;
  } else {
    selTimeEl.textContent = 'なし';
  }

  deleteBtn.disabled = !state.selection;
  cropBtn.disabled = !state.selection;
  undoBtn.disabled = state.history.length === 0;
  drawOverlay();
}

// 秒数を「分:秒.ミリ秒」形式の文字列にする
function formatTime(sec, withMs = true) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sStr = withMs ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${m}:${sStr}`;
}

// ボタンのクリック処理
playBtn.addEventListener('click', togglePlay);
deleteBtn.addEventListener('click', deleteSelection);
cropBtn.addEventListener('click', cropSelection);
undoBtn.addEventListener('click', undo);
exportBtn.addEventListener('click', exportAudio);

// ボタンを押した後にフォーカスを外す（スペースキーでボタンが再度押されるのを防ぐ）
controls.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) btn.blur();
});

// キーボードショートカット
document.addEventListener('keydown', (e) => {
  if (!state.buffer) return;
  // セレクトボックス操作中はショートカットを無効にする
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;

  if (e.code === 'Space') {
    // スペース：再生/停止
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // Delete / Backspace：選択範囲を削除
    e.preventDefault();
    deleteSelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    // Ctrl+Z：元に戻す
    e.preventDefault();
    undo();
  } else if (e.key === 'Escape') {
    // Esc：選択を解除
    state.selection = null;
    updateUI();
  }
});
