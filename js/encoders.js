'use strict';

// =====================================================
// 書き出し用エンコーダ（WAV / OGG(Opus) / M4A(AAC)）
// OGG・M4A は Chrome 標準の WebCodecs（AudioEncoder）で圧縮し、
// ファイルの入れ物（コンテナ）はこのファイル内で組み立てる
// =====================================================

// 書き出し形式ごとの拡張子
const EXPORT_EXT = { wav16: 'wav', wav24: 'wav', wav32: 'wav', ogg: 'ogg', m4a: 'm4a' };

// 圧縮形式ごとの WebCodecs 設定（対応確認にも使う）
const CODEC_CONFIGS = {
  ogg: { codec: 'opus', opus: { format: 'opus' } },
  m4a: { codec: 'mp4a.40.2', aac: { format: 'aac' } }, // AAC-LC
};

// 指定形式でエンコードしてBlobを返す
async function encodeAudio(buffer, format, bitrate) {
  switch (format) {
    case 'wav16': return new Blob([encodeWav(buffer, 16)], { type: 'audio/wav' });
    case 'wav24': return new Blob([encodeWav(buffer, 24)], { type: 'audio/wav' });
    case 'wav32': return new Blob([encodeWav(buffer, 32)], { type: 'audio/wav' });
    case 'ogg': return encodeOggOpus(buffer, bitrate);
    case 'm4a': return encodeM4aAac(buffer, bitrate);
    default: throw new Error('未対応の形式です: ' + format);
  }
}

// ブラウザが圧縮形式に対応しているか確認する（UIの選択肢の有効/無効に使う）
async function isFormatSupported(format) {
  if (!CODEC_CONFIGS[format]) return true; // WAVは常に対応
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const config = { ...CODEC_CONFIGS[format], sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };
    return (await AudioEncoder.isConfigSupported(config)).supported;
  } catch (_) {
    return false;
  }
}

// =====================================================
// WAV
// =====================================================

// AudioBufferをWAV形式のバイナリに変換する
function encodeWav(buffer, bits) {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = bits / 8;
  const isFloat = bits === 32;
  const blockAlign = channels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // --- RIFFヘッダ ---
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');

  // --- fmtチャンク（フォーマット情報） ---
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);                       // fmtチャンクのサイズ
  view.setUint16(20, isFloat ? 3 : 1, true);          // 1=PCM, 3=浮動小数点
  view.setUint16(22, channels, true);                 // チャンネル数
  view.setUint32(24, sampleRate, true);               // サンプルレート
  view.setUint32(28, sampleRate * blockAlign, true);  // 1秒あたりのバイト数
  view.setUint16(32, blockAlign, true);               // 1サンプル(全ch)のバイト数
  view.setUint16(34, bits, true);                     // ビット深度

  // --- dataチャンク（音声データ本体） ---
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // 各チャンネルのデータを取得しておく
  const chData = [];
  for (let ch = 0; ch < channels; ch++) chData.push(buffer.getChannelData(ch));

  // チャンネルを交互に並べて（インターリーブ）書き込む
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const s = Math.max(-1, Math.min(1, chData[ch][i])); // -1〜1に収める
      if (isFloat) {
        view.setFloat32(offset, s, true);
      } else if (bits === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      } else {
        // 24bitは3バイトに分けてリトルエンディアンで書き込む
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
        view.setUint8(offset, v & 0xFF);
        view.setUint8(offset + 1, (v >> 8) & 0xFF);
        view.setUint8(offset + 2, (v >> 16) & 0xFF);
      }
      offset += bytesPerSample;
    }
  }
  return out;
}

// =====================================================
// WebCodecs による圧縮（OGG・M4A 共通）
// =====================================================

// サンプルレート・チャンネル数をエンコーダが扱える形に変換する
async function prepareBuffer(buffer, sampleRate, maxChannels) {
  const channels = Math.min(buffer.numberOfChannels, maxChannels);
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === channels) return buffer;

  // OfflineAudioContextで再生成することで、再サンプリングとダウンミックスを行う
  const length = Math.ceil((buffer.length * sampleRate) / buffer.sampleRate);
  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

// エンコーダ設定にブラウザが対応しているか確認し、非対応ならエラーにする
async function assertSupported(config) {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error('このブラウザは WebCodecs（AudioEncoder）に対応していません');
  }
  const { supported } = await AudioEncoder.isConfigSupported(config);
  if (!supported) {
    throw new Error(`このブラウザは ${config.codec}（${config.sampleRate}Hz / ${config.numberOfChannels}ch / ${config.bitrate / 1000}kbps）のエンコードに対応していません`);
  }
}

// AudioBufferをWebCodecsで圧縮し、圧縮済みパケットの一覧を返す
async function encodeWithWebCodecs(buffer, config) {
  const packets = [];      // 圧縮済みデータ { data, timestamp }
  let description = null; // デコーダ用の設定データ（AACのAudioSpecificConfigなど）
  let encodeError = null;
  let wake = null;         // キューの空き待ちを解除する関数

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, timestamp: chunk.timestamp });
      const desc = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (desc && !description) description = toBytes(desc);
    },
    error: (e) => {
      encodeError = e;
      if (wake) wake();
    },
  });
  // キューが減ったら待機を解除する
  encoder.addEventListener('dequeue', () => { if (wake) wake(); });
  encoder.configure(config);

  const sampleRate = config.sampleRate;
  const channels = config.numberOfChannels;
  const chData = [];
  for (let ch = 0; ch < channels; ch++) chData.push(buffer.getChannelData(ch));

  // 0.1秒ずつ区切ってエンコーダに渡す
  const blockSize = Math.round(sampleRate / 10);
  for (let pos = 0; pos < buffer.length && !encodeError; pos += blockSize) {
    const n = Math.min(blockSize, buffer.length - pos);
    // チャンネルごとに並べた（プレーナー形式の）データを作る
    const planar = new Float32Array(n * channels);
    for (let ch = 0; ch < channels; ch++) planar.set(chData[ch].subarray(pos, pos + n), ch * n);

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: n,
      numberOfChannels: channels,
      timestamp: Math.round((pos * 1e6) / sampleRate), // マイクロ秒単位
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();

    // エンコーダの処理待ちが溜まりすぎないように待機する
    while (encoder.encodeQueueSize > 10 && !encodeError) {
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  }

  // 残りのデータをすべて出力させてから終了
  try {
    if (!encodeError) await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (encodeError) throw encodeError;
  return { packets, description };
}

// ArrayBuffer / TypedArray をコピーした Uint8Array に変換する
function toBytes(src) {
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  return new Uint8Array(src).slice();
}

// =====================================================
// OGG (Opus)
// =====================================================

// AudioBufferをOGG(Opus)ファイルに変換する
async function encodeOggOpus(buffer, bitrate) {
  // Opusは48kHz・2chまでで扱う
  const input = await prepareBuffer(buffer, 48000, 2);
  const channels = input.numberOfChannels;
  const config = { ...CODEC_CONFIGS.ogg, sampleRate: 48000, numberOfChannels: channels, bitrate };
  await assertSupported(config);

  const { packets, description } = await encodeWithWebCodecs(input, config);

  // 先頭の読み飛ばしサンプル数（エンコーダの遅延分）
  // Chromeが OpusHead 形式の設定データを返した場合はその値を使う
  let preSkip = 312; // libopus の標準的な遅延（48kHz時）
  if (description && description.length >= 12 && asciiOf(description, 0, 8) === 'OpusHead') {
    preSkip = description[10] | (description[11] << 8);
  }

  // OpusHead（識別ヘッダ）：19バイト
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(ascii('OpusHead'), 0);
  head[8] = 1;                                 // バージョン
  head[9] = channels;                          // チャンネル数
  hv.setUint16(10, preSkip, true);             // 読み飛ばしサンプル数
  hv.setUint32(12, buffer.sampleRate, true);   // 元のサンプルレート（情報用）
  hv.setInt16(16, 0, true);                    // 出力ゲイン
  head[18] = 0;                                // チャンネルマッピング（モノラル/ステレオ）

  // OpusTags（コメントヘッダ）
  const vendor = ascii('AudioClipper');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tv = new DataView(tags.buffer);
  tags.set(ascii('OpusTags'), 0);
  tv.setUint32(8, vendor.length, true);        // ベンダー名の長さ
  tags.set(vendor, 12);                        // ベンダー名
  tv.setUint32(12 + vendor.length, 0, true);   // コメント数（なし）

  const pages = muxOgg(head, tags, packets.map((p) => p.data), preSkip + input.length);
  return new Blob(pages, { type: 'audio/ogg' });
}

// Opusパケット1つに含まれるサンプル数（48kHz換算）を先頭バイト(TOC)から求める
function opusPacketSamples(packet) {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSamples;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3];   // SILK: 10/20/40/60ms
  else if (config < 16) frameSamples = [480, 960][config & 1];          // Hybrid: 10/20ms
  else frameSamples = [120, 240, 480, 960][config & 3];                 // CELT: 2.5/5/10/20ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] & 0x3F) : 2;
  return frameSamples * frames;
}

// ヘッダとOpusパケットをOGGページに詰める
function muxOgg(head, tags, packets, finalGranule) {
  const serial = (Math.random() * 0x100000000) >>> 0; // ストリーム識別番号
  const pages = [];
  let sequence = 0;

  // 1ページ分のバイナリを作る
  const writePage = (packetList, granule, flags) => {
    // セグメントテーブル：パケットを255バイト単位に区切った長さの一覧
    const segments = [];
    let bodyLength = 0;
    for (const p of packetList) {
      let len = p.length;
      while (len >= 255) { segments.push(255); len -= 255; }
      segments.push(len);
      bodyLength += p.length;
    }

    const page = new Uint8Array(27 + segments.length + bodyLength);
    const v = new DataView(page.buffer);
    page.set(ascii('OggS'), 0);                 // ページの目印
    page[4] = 0;                                // バージョン
    page[5] = flags;                            // 0x02=先頭ページ, 0x04=最終ページ
    v.setBigUint64(6, BigInt(granule), true);   // このページ終了時点のサンプル位置
    v.setUint32(14, serial, true);              // ストリーム識別番号
    v.setUint32(18, sequence++, true);          // ページ番号
    v.setUint32(22, 0, true);                   // CRC（後で書き込む）
    page[26] = segments.length;                 // セグメント数
    page.set(segments, 27);
    let offset = 27 + segments.length;
    for (const p of packetList) { page.set(p, offset); offset += p.length; }

    v.setUint32(22, oggCrc32(page), true);      // ページ全体のCRCを書き込む
    pages.push(page);
  };

  // 1・2ページ目はヘッダ専用
  writePage([head], 0, 0x02);
  writePage([tags], 0, 0x00);

  // 音声パケットを、セグメント数が255を超えない範囲でページにまとめる
  let current = [];
  let segmentCount = 0;
  let granule = 0;
  for (const p of packets) {
    const need = Math.floor(p.length / 255) + 1;
    if (current.length > 0 && segmentCount + need > 255) {
      writePage(current, Math.min(granule, finalGranule), 0x00);
      current = [];
      segmentCount = 0;
    }
    current.push(p);
    segmentCount += need;
    granule += opusPacketSamples(p);
  }
  // 最終ページ：サンプル位置を元の長さに合わせ、末尾の余分な無音を切り捨てさせる
  writePage(current, Math.min(granule, finalGranule), 0x04);
  return pages;
}

// OGG用のCRC32テーブル（多項式 0x04C11DB7）
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
    table[i] = r >>> 0;
  }
  return table;
})();

// OGGページのCRC32を計算する
function oggCrc32(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
  }
  return crc;
}

// =====================================================
// M4A (AAC)
// =====================================================

// AudioBufferをM4A(AAC)ファイルに変換する
async function encodeM4aAac(buffer, bitrate) {
  // AACエンコーダは44.1kHz / 48kHz・2chまでで扱う
  const sampleRate = (buffer.sampleRate === 44100 || buffer.sampleRate === 48000) ? buffer.sampleRate : 48000;
  const input = await prepareBuffer(buffer, sampleRate, 2);
  const channels = input.numberOfChannels;
  const config = { ...CODEC_CONFIGS.m4a, sampleRate, numberOfChannels: channels, bitrate };
  await assertSupported(config);

  const { packets, description } = await encodeWithWebCodecs(input, config);
  if (packets.length === 0) throw new Error('AACエンコードの結果が空でした');

  // デコーダ設定（AudioSpecificConfig）：Chromeが返さない場合は自前で作る
  const asc = (description && description.length >= 2) ? description : buildAudioSpecificConfig(sampleRate, channels);

  // エンコーダの遅延（プライミング）：先頭パケットの時刻が負ならその分を読み飛ばす
  const priming = packets[0].timestamp < 0 ? Math.round((-packets[0].timestamp * sampleRate) / 1e6) : 0;

  return muxM4a(packets.map((p) => p.data), asc, sampleRate, channels, priming, input.length, bitrate);
}

// AAC-LC 用の AudioSpecificConfig（2バイト）を作る
function buildAudioSpecificConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const index = rates.indexOf(sampleRate);
  // 5bit:オブジェクト種別(2=AAC-LC) / 4bit:サンプルレート番号 / 4bit:チャンネル数
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
}

// AACパケットをMP4(M4A)の入れ物に詰める
function muxM4a(frames, asc, sampleRate, channels, priming, originalLength, bitrate) {
  const SAMPLES_PER_FRAME = 1024; // AAC-LCは1パケット1024サンプル
  const mediaSamples = frames.length * SAMPLES_PER_FRAME;
  const sizes = frames.map((f) => f.length);
  const dataSize = sizes.reduce((a, b) => a + b, 0);

  // 再生する長さ：元の長さに合わせ、最終パケットの埋め合わせ（末尾の余分な無音）を除く
  const playLength = Math.min(originalLength, mediaSamples - priming);

  // 表示用の回転行列（単位行列）
  const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

  // ファイル種別
  const ftyp = mp4Box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('isom'), ascii('mp42'));

  // AACのデコーダ情報（esds）
  const esds = mp4FullBox('esds', 0, 0,
    mp4Descriptor(0x03, u16(1), u8(0),                               // ES記述子
      mp4Descriptor(0x04, u8(0x40, 0x15),                            // 0x40=AAC, 0x15=音声ストリーム
        u24(sizes.reduce((a, b) => Math.max(a, b), 0)), u32(bitrate, bitrate),             // バッファサイズ・ビットレート
        mp4Descriptor(0x05, asc)),                                   // AudioSpecificConfig
      mp4Descriptor(0x06, u8(0x02))));                               // SL設定

  // moov（再生に必要な情報一式）を作る。chunkOffset は音声データの開始位置
  const buildMoov = (chunkOffset) => mp4Box('moov',
    // 全体のヘッダ：時間単位=サンプルレート
    mp4FullBox('mvhd', 0, 0, u32(0, 0, sampleRate, playLength, 0x00010000), u16(0x0100, 0),
      u32(0, 0), u32(...MATRIX), u32(0, 0, 0, 0, 0, 0), u32(2)),
    mp4Box('trak',
      // トラックのヘッダ（フラグ3=有効・再生対象）
      mp4FullBox('tkhd', 0, 3, u32(0, 0, 1, 0, playLength, 0, 0), u16(0, 0, 0x0100, 0),
        u32(...MATRIX), u32(0, 0)),
      // 編集リスト：先頭の遅延分を飛ばし、元の長さだけ再生する
      mp4Box('edts', mp4FullBox('elst', 0, 0, u32(1, playLength, priming), u16(1, 0))),
      mp4Box('mdia',
        mp4FullBox('mdhd', 0, 0, u32(0, 0, sampleRate, mediaSamples), u16(0x55C4, 0)), // 言語=und
        mp4FullBox('hdlr', 0, 0, u32(0), ascii('soun'), u32(0, 0, 0), ascii('SoundHandler\0')),
        mp4Box('minf',
          mp4FullBox('smhd', 0, 0, u16(0, 0)),
          mp4Box('dinf', mp4FullBox('dref', 0, 0, u32(1), mp4FullBox('url ', 0, 1))),
          mp4Box('stbl',
            // 音声形式の説明（mp4a）
            mp4FullBox('stsd', 0, 0, u32(1),
              mp4Box('mp4a', u8(0, 0, 0, 0, 0, 0), u16(1), u32(0, 0),
                u16(channels, 16, 0, 0), u32(sampleRate * 65536), esds)),
            // 各パケットの長さ（時間）：すべて1024サンプル
            mp4FullBox('stts', 0, 0, u32(1, frames.length, SAMPLES_PER_FRAME)),
            // 全パケットを1つのチャンクにまとめる
            mp4FullBox('stsc', 0, 0, u32(1, 1, frames.length, 1)),
            // 各パケットのバイト数
            mp4FullBox('stsz', 0, 0, u32(0, frames.length), u32Array(sizes)),
            // チャンクの開始位置
            mp4FullBox('stco', 0, 0, u32(1, chunkOffset)))))));

  // moovのサイズは開始位置の値に依存しないので、一度作ってサイズを求めてから作り直す
  const moovSize = buildMoov(0).length;
  const moov = buildMoov(ftyp.length + moovSize + 8);

  // 音声データ本体（mdat）
  const mdatHeader = concatBytes([u32(8 + dataSize), ascii('mdat')]);
  return new Blob([ftyp, moov, mdatHeader, ...frames], { type: 'audio/mp4' });
}

// MP4のボックス（サイズ + 種別 + 中身）を作る
function mp4Box(type, ...parts) {
  const body = concatBytes(parts);
  return concatBytes([u32(8 + body.length), ascii(type), body]);
}

// バージョン・フラグ付きのMP4ボックスを作る
function mp4FullBox(type, version, flags, ...parts) {
  return mp4Box(type, u8(version), u24(flags), ...parts);
}

// esds内の記述子（タグ + 長さ + 中身）を作る ※中身は127バイト以下を想定
function mp4Descriptor(tag, ...parts) {
  const body = concatBytes(parts);
  return concatBytes([u8(tag, body.length), body]);
}

// =====================================================
// バイト列作成の補助関数
// =====================================================

// 文字列をASCIIのバイト列にする
function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// バイト列の一部をASCII文字列として読む
function asciiOf(bytes, start, length) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

// 8bit値の並び
function u8(...values) {
  return new Uint8Array(values);
}

// 16bit値の並び（ビッグエンディアン）
function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => v.setUint16(i * 2, x));
  return out;
}

// 24bit値1つ（ビッグエンディアン）
function u24(value) {
  return new Uint8Array([(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
}

// 32bit値の並び（ビッグエンディアン）
function u32(...values) {
  return u32Array(values);
}

// 32bit値の配列（ビッグエンディアン）※大きな配列にも対応
function u32Array(values) {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => v.setUint32(i * 4, x));
  return out;
}

// 複数のバイト列を1つにつなげる
function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
