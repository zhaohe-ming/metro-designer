import { muxAvcToMp4, normalizeAvcSamples } from './mp4Muxer';

function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('mp4Muxer', () => {
  test('packs faststart ftyp + moov + mdat with accurate chunk offsets for AVCC samples', async () => {
    const fakeAvcC = new Uint8Array([1, 0x4d, 0x00, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x4d, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
    const sample1 = new Uint8Array([0, 0, 0, 4, 0x65, 1, 2, 3]);
    const sample2 = new Uint8Array([0, 0, 0, 3, 0x41, 9, 8]);

    const blob = muxAvcToMp4({
      width: 1920,
      height: 1080,
      fps: 30,
      decoderDescription: fakeAvcC,
      samples: [
        { data: sample1, isKeyframe: true },
        { data: sample2, isKeyframe: false }
      ]
    });

    expect(blob.type).toBe('video/mp4');
    const bytes = await blobToBytes(blob);

    // Top-level boxes: ftyp -> moov -> mdat
    const ftypSize = readU32(bytes, 0);
    expect(readBoxType(bytes, 0)).toBe('ftyp');

    const moovOffset = ftypSize;
    const moovSize = readU32(bytes, moovOffset);
    expect(readBoxType(bytes, moovOffset)).toBe('moov');

    const mdatOffset = moovOffset + moovSize;
    const mdatSize = readU32(bytes, mdatOffset);
    expect(readBoxType(bytes, mdatOffset)).toBe('mdat');
    expect(mdatSize).toBe(8 + sample1.byteLength + sample2.byteLength);
    expect(bytes.byteLength).toBe(mdatOffset + mdatSize);

    // Payload inside mdat matches concatenated samples exactly
    expect(Array.from(bytes.slice(mdatOffset + 8, mdatOffset + 8 + sample1.byteLength))).toEqual(Array.from(sample1));
    expect(Array.from(bytes.slice(mdatOffset + 8 + sample1.byteLength))).toEqual(Array.from(sample2));
  });

  test('converts Annex-B bitstream and extracts SPS/PPS when decoderDescription is absent', () => {
    const annexBKeyframe = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0xaa, // SPS (type 7)
      0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,       // PPS (type 8)
      0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21        // IDR slice (type 5, len 4)
    ]);

    const { samples, avcCBytes } = normalizeAvcSamples([{ data: annexBKeyframe, isKeyframe: true }]);
    expect(avcCBytes[0]).toBe(1);
    expect(avcCBytes[1]).toBe(0x42);
    // Converted sample should be 4-byte length prefix (0,0,0,4) + 4 bytes IDR slice
    expect(Array.from(samples[0].data)).toEqual([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21]);
  });
});
