'use strict';

// =====================================================
// AudioClipper - ブラウザ上でWAVファイルを切り取り編集するツール
// =====================================================

// ---------- DOM要素の取得 ----------
const dropZone = document.getElementById('dropZone');
const dropText = document.getElementById('dropText');
const fileInput = document.getElementById('fileInput');
const waveArea = document.getElementById('waveArea');
const waveWrap = document.getElementById('waveWrap');
const waveScroll = document.getElementById('waveScroll');
const waveScrollInner = document.getElementById('waveScrollInner');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomFitBtn = document.getElementById('zoomFitBtn');
const zoomSelBtn = document.getElementById('zoomSelBtn');
const viewRangeEl = document.getElementById('viewRange');
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
  viewStart: 0,      // 波形の表示範囲の先頭（サンプル単位・小数可）
  viewLength: 1,     // 波形の表示範囲の長さ（サンプル単位・小数可）
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
  drawOverlay(getPlayheadSample());
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
let playheadWasVisible = false; // 前のフレームで再生位置が表示範囲内にあったか（自動スクロール判定用）

// ---------- マウス操作関連の状態 ----------
let dragging = false;      // ドラッグ中かどうか
let dragAnchor = 0;        // ドラッグを開始したサンプル位置
let dragStartX = 0;        // ドラッグを開始したX座標（クリック判定用）
let dragMoved = false;     // 一定距離以上動いたか
let beforeDrag = null;     // ドラッグ開始前の選択範囲とカーソル（ピンチ開始時に元に戻す用）

// ---------- タッチのピンチ操作関連の状態 ----------
const activePointers = new Map(); // 押されているポインタ（ID → X座標）
let pinch = null;          // ピンチ中の情報 { dist, length, anchor }

// 波形のピーク値キャッシュ（一定サンプル数ごとの最小値・最大値。オーディオデータが変わったら再計算）
let blockPeaks = null;
// ピーク値キャッシュの1ブロックあたりのサンプル数
const PEAK_BLOCK = 256;

// 1サンプルを最大何CSSピクセルの幅まで拡大できるか
const MAX_PX_PER_SAMPLE = 8;
// スクロールバー用の中身の最大幅（ブラウザの要素幅の上限を超えないようにする）
const MAX_SCROLL_WIDTH = 10_000_000;
// プログラムから設定した直近のスクロール位置（スクロールイベントの無限ループ防止用）
let lastScrollLeft = 0;

// 読み込みに対応する拡張子（デコードはブラウザ標準機能で行う）
const SUPPORTED_EXT = /\.(wav|mp3|ogg|oga|opus|flac|m4a)$/i;

// ドロップエリアの初期メッセージ（PC 向け・スマホ向けの両方の要素を控えておく）
const DEFAULT_DROP_NODES = [...dropText.childNodes].map((node) => node.cloneNode(true));

// ドロップエリアを初期メッセージに戻す
function resetDropText() {
  dropText.replaceChildren(...DEFAULT_DROP_NODES.map((node) => node.cloneNode(true)));
}

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
    // 読み込み直後は全体を表示する
    state.viewStart = 0;
    state.viewLength = buffer.length;
    blockPeaks = null;

    // ※ エクスポート形式の選択はリセットせず、前回の選択を引き継ぐ

    // 編集用のUIを表示
    waveArea.hidden = false;
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
    resetDropText();
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
  // 幅が変わると拡大できる上限も変わるため、表示範囲を整えてから描画する
  clampView();
  onViewChanged();
}

// 表示領域のサイズが変わったら再描画する
new ResizeObserver(() => {
  if (state.buffer) resizeCanvases();
}).observe(waveWrap);

// 一定サンプル数（PEAK_BLOCK）ごとの最小値・最大値を計算する
// （縮小表示時はこのブロック単位の値をまとめて使い、毎回全サンプルを走査しないようにする）
function buildBlockPeaks(buffer) {
  const len = buffer.length;
  const blocks = Math.ceil(len / PEAK_BLOCK);
  const peaks = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    const min = new Float32Array(blocks);
    const max = new Float32Array(blocks);
    for (let b = 0; b < blocks; b++) {
      const from = b * PEAK_BLOCK;
      const to = Math.min(len, from + PEAK_BLOCK);
      let lo = 1, hi = -1;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

// 表示範囲内について、横1ピクセルごとの最小値・最大値（ピーク）を計算する
function computeViewPeaks(ch, width) {
  const buffer = state.buffer;
  const len = buffer.length;
  const data = buffer.getChannelData(ch);
  const block = blockPeaks[ch];
  const spp = state.viewLength / width; // 1ピクセルあたりのサンプル数
  const min = new Float32Array(width);
  const max = new Float32Array(width);

  // 指定位置の値を前後のサンプルから直線補間して求める（拡大表示で線をつなげるため）
  const sampleAt = (pos) => {
    const i = Math.min(len - 1, Math.max(0, Math.floor(pos)));
    const next = Math.min(len - 1, i + 1);
    const t = pos - i;
    return data[i] * (1 - t) + data[next] * t;
  };

  for (let x = 0; x < width; x++) {
    // このピクセルに対応するサンプル範囲
    const from = state.viewStart + x * spp;
    const to = from + spp;
    let lo = 1, hi = -1;

    if (from >= len) {
      // データの末尾より後ろは描画しない（lo > hi のままにする）
    } else if (spp >= PEAK_BLOCK) {
      // 縮小表示：ブロック単位のピーク値をまとめる
      const b0 = Math.floor(from / PEAK_BLOCK);
      const b1 = Math.min(block.min.length, Math.max(b0 + 1, Math.floor(to / PEAK_BLOCK)));
      for (let b = b0; b < b1; b++) {
        if (block.min[b] < lo) lo = block.min[b];
        if (block.max[b] > hi) hi = block.max[b];
      }
    } else if (spp >= 1) {
      // 中程度の拡大：サンプルを直接走査する
      const s0 = Math.floor(from);
      const s1 = Math.min(len, Math.max(s0 + 1, Math.floor(to)));
      for (let i = s0; i < s1; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    } else {
      // 1サンプルが複数ピクセルにまたがる拡大：補間した値の間を線で結ぶ
      const v0 = sampleAt(from);
      const v1 = sampleAt(to);
      lo = Math.min(v0, v1);
      hi = Math.max(v0, v1);
    }
    min[x] = lo;
    max[x] = hi;
  }
  return { min, max };
}

// 波形とタイムグリッドを描画する（下層キャンバス）
function drawWaveform() {
  const { width: W, height: H } = waveCanvas;
  waveCtx.clearRect(0, 0, W, H);
  const buffer = state.buffer;
  if (!buffer) return;

  const dpr = window.devicePixelRatio || 1;
  drawTimeGrid(W, H, dpr);

  // ブロック単位のピーク値はキャッシュがなければ計算する
  if (!blockPeaks) blockPeaks = buildBlockPeaks(buffer);

  // チャンネルごとに縦方向のレーンを分けて描画
  const channels = buffer.numberOfChannels;
  const laneH = H / channels;
  for (let ch = 0; ch < channels; ch++) {
    const { min, max } = computeViewPeaks(ch, W);
    const mid = laneH * ch + laneH / 2;
    const amp = laneH / 2 * 0.9;

    // 中心線
    waveCtx.fillStyle = COLORS.centerLine;
    waveCtx.fillRect(0, Math.round(mid), W, 1);

    // 各ピクセル列に縦線を描いて波形を表現
    waveCtx.fillStyle = COLORS.wave;
    for (let x = 0; x < W; x++) {
      if (min[x] > max[x]) continue; // データのない位置は描かない
      const top = mid - max[x] * amp;
      const bottom = mid - min[x] * amp;
      waveCtx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }
}

// 時間の目盛りを描画する（表示範囲内のみ）
function drawTimeGrid(W, H, dpr) {
  const sr = state.buffer.sampleRate;
  const viewStartSec = state.viewStart / sr;
  const viewSec = state.viewLength / sr;
  // 目盛り間隔の候補から、約90px以上の間隔になるものを選ぶ
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const minGapPx = 90 * dpr;
  const step = steps.find((s) => (s / viewSec) * W >= minGapPx) || steps[steps.length - 1];

  waveCtx.fillStyle = COLORS.grid;
  waveCtx.font = `${11 * dpr}px system-ui, sans-serif`;
  waveCtx.textBaseline = 'top';
  // 誤差が蓄積しないよう、目盛りの番号から時刻を求める
  const endSec = Math.min(state.buffer.duration, viewStartSec + viewSec);
  for (let i = Math.ceil(viewStartSec / step); i * step <= endSec; i++) {
    const t = i * step;
    const x = Math.round(((t - viewStartSec) / viewSec) * W);
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

// サンプル位置 → キャンバスのX座標（表示範囲を基準にする）
function sampleToX(sample) {
  return Math.round(((sample - state.viewStart) / state.viewLength) * overlayCanvas.width);
}

// 画面上のX座標 → サンプル位置（小数のまま。表示範囲の外は端に丸める）
function clientXToSample(clientX) {
  const rect = overlayCanvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return state.viewStart + ratio * state.viewLength;
}

// マウスイベントの位置 → サンプル位置（整数）
function eventToSample(e) {
  return Math.min(state.buffer.length, Math.max(0, Math.round(clientXToSample(e.clientX))));
}

// =====================================================
// 表示範囲（拡大・縮小・スクロール）
// =====================================================

// 波形キャンバスの表示幅（CSSピクセル）
function viewWidthPx() {
  return overlayCanvas.clientWidth || 1;
}

// 拡大したときの表示範囲の最小サンプル数
function minViewLength() {
  return Math.min(state.buffer.length, Math.max(16, viewWidthPx() / MAX_PX_PER_SAMPLE));
}

// 表示範囲がデータの範囲・拡大の上限からはみ出さないように整える
function clampView() {
  const len = state.buffer.length;
  state.viewLength = Math.min(len, Math.max(minViewLength(), state.viewLength));
  state.viewStart = Math.min(len - state.viewLength, Math.max(0, state.viewStart));
}

// 全体を表示しているかどうか
function isFullView() {
  return state.viewLength >= state.buffer.length;
}

// 表示範囲を変更して描き直す
function setView(start, length) {
  state.viewStart = start;
  state.viewLength = length;
  clampView();
  onViewChanged();
}

// 表示範囲が変わったときに波形・スクロールバー・表示を更新する
// （fromScrollbar が true のときはスクロールバー自身の操作なので位置を書き戻さない）
function onViewChanged(fromScrollbar = false) {
  drawWaveform();
  drawOverlay(getPlayheadSample());
  if (!fromScrollbar) updateScrollbar();
  updateZoomUI();
}

// 指定位置（anchor）を画面上で動かさずに factor 倍に拡大する（1未満なら縮小）
function zoomBy(factor, anchor = defaultZoomAnchor()) {
  const ratio = (anchor - state.viewStart) / state.viewLength; // 画面上の anchor の位置（0〜1）
  const newLength = Math.min(state.buffer.length, Math.max(minViewLength(), state.viewLength / factor));
  setView(anchor - ratio * newLength, newLength);
}

// ボタン・キー操作で拡大縮小するときの基準位置
// （選択範囲やカーソルが表示中ならそこ、なければ表示範囲の中央）
function defaultZoomAnchor() {
  const viewEnd = state.viewStart + state.viewLength;
  const pos = state.selection
    ? (state.selection.start + state.selection.end) / 2
    : state.cursor;
  return pos >= state.viewStart && pos <= viewEnd ? pos : state.viewStart + state.viewLength / 2;
}

// 全体を表示する
function zoomFit() {
  setView(0, state.buffer.length);
}

// 選択範囲が画面いっぱいになるように拡大する（左右に少し余白をとる）
function zoomToSelection() {
  const sel = state.selection;
  if (!sel) return;
  const pad = (sel.end - sel.start) * 0.05;
  setView(sel.start - pad, sel.end - sel.start + pad * 2);
}

// 表示範囲を指定サンプル数だけ横に移動する
function scrollViewBy(samples) {
  setView(state.viewStart + samples, state.viewLength);
}

// スクロールバーの長さと位置を表示範囲に合わせる
function updateScrollbar() {
  const clientW = waveScroll.clientWidth;
  // 中身の幅を「全体 ÷ 表示範囲」倍にすると、つまみの大きさが表示範囲の割合になる
  const innerW = Math.min(MAX_SCROLL_WIDTH, Math.round(clientW * (state.buffer.length / state.viewLength)));
  waveScrollInner.style.width = `${innerW}px`;
  const maxScroll = innerW - clientW;
  const maxStart = state.buffer.length - state.viewLength;
  waveScroll.scrollLeft = maxStart > 0 ? (state.viewStart / maxStart) * maxScroll : 0;
  // 実際に設定された値（ブラウザで丸められる）を控えておく
  lastScrollLeft = waveScroll.scrollLeft;
}

// スクロールバーが操作されたら表示範囲を移動する
waveScroll.addEventListener('scroll', () => {
  if (!state.buffer) return;
  // プログラムから設定した位置と同じなら何もしない（無限ループ防止）
  if (Math.abs(waveScroll.scrollLeft - lastScrollLeft) < 0.5) return;
  lastScrollLeft = waveScroll.scrollLeft;
  const maxScroll = waveScroll.scrollWidth - waveScroll.clientWidth;
  const maxStart = state.buffer.length - state.viewLength;
  if (maxScroll <= 0) return;
  state.viewStart = (waveScroll.scrollLeft / maxScroll) * maxStart;
  clampView();
  onViewChanged(true);
});

// 拡大縮小ボタンの有効/無効と表示範囲の時間を更新する
function updateZoomUI() {
  const sr = state.buffer.sampleRate;
  zoomInBtn.disabled = state.viewLength <= minViewLength();
  zoomOutBtn.disabled = isFullView();
  zoomFitBtn.disabled = isFullView();
  zoomSelBtn.disabled = !state.selection;
  const zoom = state.buffer.length / state.viewLength;
  const zoomText = zoom < 10 ? zoom.toFixed(1) : Math.round(zoom).toLocaleString();
  viewRangeEl.textContent =
    `${formatTime(state.viewStart / sr)} 〜 ${formatTime((state.viewStart + state.viewLength) / sr)}（×${zoomText}）`;
}

// ボタンでの拡大・縮小
zoomInBtn.addEventListener('click', () => zoomBy(2));
zoomOutBtn.addEventListener('click', () => zoomBy(0.5));
zoomFitBtn.addEventListener('click', zoomFit);
zoomSelBtn.addEventListener('click', zoomToSelection);

// ボタンを押した後にフォーカスを外す（スペースキーでボタンが再度押されるのを防ぐ）
waveArea.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) btn.blur();
});

// マウスホイール操作
// ・Ctrl（Mac は ⌘）+ホイール、またはトラックパッドのピンチ：マウス位置を中心に拡大・縮小
// ・Shift+ホイール、または横スクロール：表示範囲を横に移動
waveWrap.addEventListener('wheel', (e) => {
  if (!state.buffer) return;
  // スクロール量の単位（ピクセル / 行 / ページ）をピクセルにそろえる
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewWidthPx() : 1;

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); // ブラウザ自体の拡大を止める
    zoomBy(Math.exp(-e.deltaY * unit * 0.002), clientXToSample(e.clientX));
    return;
  }

  // 横方向の移動量（Shift 押下時は縦ホイールを横移動として扱う）
  let dx = 0;
  if (e.shiftKey) dx = e.deltaX || e.deltaY;
  else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dx = e.deltaX;
  // 通常の縦ホイールはページのスクロールに任せる
  if (!dx || isFullView()) return;
  e.preventDefault();
  scrollViewBy(dx * unit * (state.viewLength / viewWidthPx()));
}, { passive: false });

// =====================================================
// ドラッグによる範囲選択 ／ 2本指ピンチによる拡大縮小
// =====================================================

// 2本指のピンチ操作を開始する
function startPinch() {
  const [x1, x2] = [...activePointers.values()];
  // 1本目の指で始めた選択操作は取り消して元に戻す
  dragging = false;
  if (beforeDrag) {
    state.selection = beforeDrag.selection;
    state.cursor = beforeDrag.cursor;
    updateUI();
  }
  pinch = {
    dist: Math.max(20, Math.abs(x1 - x2)),           // 開始時の指の間隔
    length: state.viewLength,                         // 開始時の表示範囲の長さ
    anchor: clientXToSample((x1 + x2) / 2),           // 指の中心にあるサンプル位置
  };
}

// ピンチ中の指の動きに合わせて拡大縮小・移動する
function updatePinch() {
  const [x1, x2] = [...activePointers.values()];
  const dist = Math.max(20, Math.abs(x1 - x2));
  const newLength = Math.min(state.buffer.length,
    Math.max(minViewLength(), pinch.length * (pinch.dist / dist)));
  // 開始時に指の中心にあった位置が、現在の指の中心に来るようにする
  const rect = overlayCanvas.getBoundingClientRect();
  const ratio = ((x1 + x2) / 2 - rect.left) / rect.width;
  setView(pinch.anchor - ratio * newLength, newLength);
}

// 範囲選択のドラッグ中に波形の外へ出たら、その方向へ表示範囲をスクロールする
function autoScrollWhileDragging(clientX) {
  if (isFullView()) return;
  const rect = overlayCanvas.getBoundingClientRect();
  let overshoot = 0; // 波形の端からはみ出した距離（ピクセル）
  if (clientX < rect.left) overshoot = clientX - rect.left;
  else if (clientX > rect.right) overshoot = clientX - rect.right;
  if (overshoot) scrollViewBy(overshoot * 0.5 * (state.viewLength / rect.width));
}

overlayCanvas.addEventListener('pointerdown', (e) => {
  if (!state.buffer || e.button !== 0) return;
  overlayCanvas.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, e.clientX);

  // 2本目の指が触れたらピンチ操作に切り替える
  if (activePointers.size === 2 && e.pointerType === 'touch') {
    startPinch();
    return;
  }
  if (activePointers.size > 1) return;

  stopPlayback();
  beforeDrag = { selection: state.selection, cursor: state.cursor };
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
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, e.clientX);
  // ピンチ中は拡大縮小のみ行う
  if (pinch) {
    if (activePointers.size >= 2) updatePinch();
    return;
  }
  if (!dragging) return;
  // 数ピクセル以上動いたらドラッグ（範囲選択）とみなす
  if (!dragMoved && Math.abs(e.clientX - dragStartX) < 3) return;
  dragMoved = true;
  autoScrollWhileDragging(e.clientX);
  setSelection(dragAnchor, eventToSample(e));
});

// 指やボタンが離れたとき（キャンセルされたときも同様に後片付けする）
function onPointerEnd(e) {
  activePointers.delete(e.pointerId);
  // ピンチ終了：すべての指が離れるまで選択操作は再開しない
  if (pinch) {
    if (activePointers.size === 0) pinch = null;
    return;
  }
  if (!dragging) return;
  dragging = false;
  if (!dragMoved && e.type === 'pointerup') {
    // ほぼ動いていなければクリック：選択を解除してカーソル位置を設定
    state.selection = null;
    state.cursor = eventToSample(e);
    updateUI();
  }
}
overlayCanvas.addEventListener('pointerup', onPointerEnd);
overlayCanvas.addEventListener('pointercancel', onPointerEnd);

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
  // 残した範囲全体を表示する
  state.viewStart = 0;
  state.viewLength = state.buffer.length;
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
  blockPeaks = null;
  // 長さが変わるため、表示範囲がはみ出さないように整える（拡大率はなるべく維持）
  clampView();
  onViewChanged();
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

  // 再生開始位置が表示範囲の外なら、そこが見えるように表示範囲を移動する
  if (!isSampleVisible(start)) setView(start, state.viewLength);
  playheadWasVisible = true;
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

// 現在の再生位置（サンプル単位）を返す（停止中は null）
function getPlayheadSample() {
  if (!sourceNode) return null;
  const elapsed = audioCtx.currentTime - playStartCtxTime;
  return Math.min(playEndSample, playStartSample + Math.round(elapsed * state.buffer.sampleRate));
}

// 指定サンプル位置が表示範囲内にあるか
function isSampleVisible(sample) {
  return sample >= state.viewStart && sample <= state.viewStart + state.viewLength;
}

// 再生位置を毎フレーム描画する
function animatePlayhead() {
  if (!sourceNode) return;
  const pos = getPlayheadSample();

  // 再生位置が表示範囲の右端を越えたら、次の範囲へページ送りする
  // （ユーザーがスクロールして再生位置を画面外にした場合は追いかけない）
  const visible = isSampleVisible(pos);
  if (!visible && playheadWasVisible && !dragging && !pinch) {
    setView(pos, state.viewLength);
  } else {
    playheadWasVisible = visible;
  }
  drawOverlay(pos);
  cursorTimeEl.textContent = formatTime(pos / state.buffer.sampleRate);
  animationId = requestAnimationFrame(animatePlayhead);
}

// =====================================================
// エクスポート（WAV / OGG / M4A）
// =====================================================

// ※ 各形式のエンコード処理は encoders.js にまとめている

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
  updateZoomUI();
  drawOverlay(getPlayheadSample());
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
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '+' || e.key === '=')) {
    // + キー：拡大（Ctrl+「+」はブラウザの拡大に任せる）
    e.preventDefault();
    zoomBy(2);
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === '-') {
    // - キー：縮小
    e.preventDefault();
    zoomBy(0.5);
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === '0') {
    // 0 キー：全体を表示
    e.preventDefault();
    zoomFit();
  }
});
