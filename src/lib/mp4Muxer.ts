// 轻量零依赖 ISO-BMFF (MP4 / H.264 avc1) 封装器（Faststart：moov 前置于 mdat）。
// 专为 WebCodecs VideoEncoder 离线逐帧导出设计，同时兼容原生 AVCC 与 Annex-B 码流输出。

export interface EncodedAvcSample {
  data: Uint8Array;
  isKeyframe: boolean;
}

export interface MuxMp4Options {
  width: number;
  height: number;
  fps: number;
  samples: EncodedAvcSample[];
  decoderDescription?: Uint8Array;
}

const ASCII = (str: string): Uint8Array => {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
};

const u16 = (v: number): Uint8Array => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v >>> 0, false);
  return b;
};

const u32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
};

const i32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v | 0, false);
  return b;
};

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) total += parts[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    out.set(parts[i], offset);
    offset += parts[i].byteLength;
  }
  return out;
};

const box = (type: string, ...payloads: Uint8Array[]): Uint8Array => {
  let payloadLen = 0;
  for (let i = 0; i < payloads.length; i += 1) payloadLen += payloads[i].byteLength;
  const total = 8 + payloadLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i) & 0xff;
  let offset = 8;
  for (let i = 0; i < payloads.length; i += 1) {
    out.set(payloads[i], offset);
    offset += payloads[i].byteLength;
  }
  return out;
};

const fullBox = (type: string, version: number, flags: number, ...payloads: Uint8Array[]): Uint8Array => {
  const vf = u32(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, vf, ...payloads);
};

const UNITY_MATRIX = concatBytes([
  i32(0x00010000), i32(0), i32(0),
  i32(0), i32(0x00010000), i32(0),
  i32(0), i32(0), i32(0x40000000)
]);

export function isAnnexBStream(data: Uint8Array): boolean {
  if (data.byteLength < 4) return false;
  return data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

export function splitAnnexBNalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let i = 0;
  const len = data.byteLength;
  const findStartCode = (from: number): { pos: number; scLen: number } | null => {
    for (let p = from; p < len - 2; p += 1) {
      if (data[p] === 0 && data[p + 1] === 0) {
        if (data[p + 2] === 1) return { pos: p, scLen: 3 };
        if (p + 3 < len && data[p + 2] === 0 && data[p + 3] === 1) return { pos: p, scLen: 4 };
      }
    }
    return null;
  };

  let cur = findStartCode(0);
  while (cur) {
    const nalStart = cur.pos + cur.scLen;
    const next = findStartCode(nalStart);
    const nalEnd = next ? next.pos : len;
    if (nalEnd > nalStart) {
      units.push(data.subarray(nalStart, nalEnd));
    }
    i = nalEnd;
    if (i >= len) break;
    cur = next;
  }
  return units;
}

export function buildAvcCFromSpsPps(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profileIdc = sps[1] ?? 0x4d;
  const profileCompat = sps[2] ?? 0x00;
  const levelIdc = sps[3] ?? 0x28;
  return concatBytes([
    new Uint8Array([
      1, // configurationVersion
      profileIdc,
      profileCompat,
      levelIdc,
      0xff, // lengthSizeMinusOne = 3 (4-byte NAL length prefix)
      0xe1 // numOfSequenceParameterSets = 1
    ]),
    u16(sps.byteLength),
    sps,
    new Uint8Array([1]), // numOfPictureParameterSets = 1
    u16(pps.byteLength),
    pps
  ]);
}

export function normalizeAvcSamples(
  rawSamples: EncodedAvcSample[],
  rawDescription?: Uint8Array
): { samples: EncodedAvcSample[]; avcCBytes: Uint8Array } {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;

  const normalized = rawSamples.map((sample) => {
    if (!isAnnexBStream(sample.data)) {
      return sample;
    }
    const nals = splitAnnexBNalUnits(sample.data);
    const vclAndSeiParts: Uint8Array[] = [];
    for (let i = 0; i < nals.length; i += 1) {
      const nal = nals[i];
      const nalType = nal[0] & 0x1f;
      if (nalType === 7 && !sps) sps = nal;
      else if (nalType === 8 && !pps) pps = nal;
      if (nalType !== 7 && nalType !== 8 && nalType !== 9) {
        vclAndSeiParts.push(u32(nal.byteLength), nal);
      }
    }
    return {
      data: vclAndSeiParts.length ? concatBytes(vclAndSeiParts) : sample.data,
      isKeyframe: sample.isKeyframe
    };
  });

  let avcCBytes = rawDescription && rawDescription.byteLength > 0 ? rawDescription : null;
  if (!avcCBytes) {
    if (sps && pps) {
      avcCBytes = buildAvcCFromSpsPps(sps, pps);
    } else {
      throw new Error('缺少 H.264 解码器配置信息 (avcC)');
    }
  }

  return { samples: normalized, avcCBytes };
}

export function muxAvcToMp4(options: MuxMp4Options): Blob {
  const { width, height, fps } = options;
  if (!options.samples.length) {
    throw new Error('没有可封装的视频帧数据');
  }

  const { samples, avcCBytes } = normalizeAvcSamples(options.samples, options.decoderDescription);

  const timescale = 90000;
  const sampleDelta = Math.max(1, Math.round(timescale / fps));
  const totalDuration = samples.length * sampleDelta;

  const ftyp = box(
    'ftyp',
    ASCII('isom'),
    u32(0x00000200),
    ASCII('isomiso2avc1mp41')
  );

  const buildMoov = (chunkOffsets: number[]): Uint8Array => {
    const mvhd = fullBox(
      'mvhd',
      0,
      0,
      u32(0), // creation_time
      u32(0), // modification_time
      u32(timescale),
      u32(totalDuration),
      i32(0x00010000), // rate 1.0
      u16(0x0100), // volume 1.0
      new Uint8Array(10), // reserved
      UNITY_MATRIX,
      new Uint8Array(24), // pre_defined
      u32(2) // next_track_ID
    );

    const tkhd = fullBox(
      'tkhd',
      0,
      0x000003, // track_enabled | track_in_movie
      u32(0), // creation_time
      u32(0), // modification_time
      u32(1), // track_ID
      u32(0), // reserved
      u32(totalDuration),
      new Uint8Array(8), // reserved
      u16(0), // layer
      u16(0), // alternate_group
      u16(0), // volume = 0 for video
      u16(0), // reserved
      UNITY_MATRIX,
      u32((width & 0xffff) << 16),
      u32((height & 0xffff) << 16)
    );

    const mdhd = fullBox(
      'mdhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(timescale),
      u32(totalDuration),
      u16(0x55c4), // 'und'
      u16(0)
    );

    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ASCII('vide'),
      new Uint8Array(12),
      ASCII('VideoHandler\0')
    );

    const vmhd = fullBox('vmhd', 0, 1, u16(0), new Uint8Array(6));
    const urlBox = fullBox('url ', 0, 1);
    const dref = fullBox('dref', 0, 0, u32(1), urlBox);
    const dinf = box('dinf', dref);

    const avcC = box('avcC', avcCBytes);
    const colr = box('colr', ASCII('nclx'), u16(1), u16(1), u16(1), new Uint8Array([0x80]));
    const avc1 = box(
      'avc1',
      new Uint8Array(6), // reserved
      u16(1), // data_reference_index
      new Uint8Array(16), // pre_defined + reserved
      u16(width),
      u16(height),
      u32(0x00480000), // horizresolution 72dpi
      u32(0x00480000), // vertresolution 72dpi
      u32(0), // reserved
      u16(1), // frame_count
      new Uint8Array(32), // compressorname
      u16(0x0018), // depth 24
      u16(0xffff), // pre_defined = -1
      avcC,
      colr
    );
    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);

    const stts = fullBox('stts', 0, 0, u32(1), u32(samples.length), u32(sampleDelta));

    const keyframeIndices: number[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].isKeyframe) keyframeIndices.push(i + 1);
    }
    const stssEntries = new Uint8Array(keyframeIndices.length * 4);
    const stssView = new DataView(stssEntries.buffer);
    keyframeIndices.forEach((idx, pos) => stssView.setUint32(pos * 4, idx, false));
    const stss = fullBox('stss', 0, 0, u32(keyframeIndices.length), stssEntries);

    // 每个 sample 对应 1 个 chunk，兼容所有硬件解码器与 QuickTime / iOS / 微信播放器
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));

    const stszEntries = new Uint8Array(samples.length * 4);
    const stszView = new DataView(stszEntries.buffer);
    samples.forEach((s, i) => stszView.setUint32(i * 4, s.data.byteLength, false));
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(samples.length), stszEntries);

    const stcoEntries = new Uint8Array(chunkOffsets.length * 4);
    const stcoView = new DataView(stcoEntries.buffer);
    chunkOffsets.forEach((off, i) => stcoView.setUint32(i * 4, off >>> 0, false));
    const stco = fullBox('stco', 0, 0, u32(chunkOffsets.length), stcoEntries);

    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    return box('moov', mvhd, trak);
  };

  // 第一遍算精确头部长度，随后回填 mdat 内每个帧的真实文件偏移
  const placeholderOffsets = new Array<number>(samples.length).fill(0);
  const placeholderMoov = buildMoov(placeholderOffsets);
  const mdatPayloadOffset = ftyp.byteLength + placeholderMoov.byteLength + 8;

  let mdatPayloadBytes = 0;
  const realOffsets: number[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    realOffsets.push(mdatPayloadOffset + mdatPayloadBytes);
    mdatPayloadBytes += samples[i].data.byteLength;
  }

  const moov = buildMoov(realOffsets);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + mdatPayloadBytes, false);
  mdatHeader.set(ASCII('mdat'), 4);

  const blobParts: BlobPart[] = [
    ftyp.buffer.slice(ftyp.byteOffset, ftyp.byteOffset + ftyp.byteLength) as ArrayBuffer,
    moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.byteLength) as ArrayBuffer,
    mdatHeader.buffer.slice(mdatHeader.byteOffset, mdatHeader.byteOffset + mdatHeader.byteLength) as ArrayBuffer,
    ...samples.map((s) => s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.byteLength) as ArrayBuffer)
  ];

  return new Blob(blobParts, { type: 'video/mp4' });
}
