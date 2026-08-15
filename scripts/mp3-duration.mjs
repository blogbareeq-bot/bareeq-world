const BITRATES = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function synchsafeSize(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function frameInfo(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const mpeg1 = versionBits === 3;
  const divider = versionBits === 0 ? 4 : versionBits === 2 ? 2 : 1;
  const sampleRate = [44100, 48000, 32000][sampleRateIndex] / divider;
  const bitrate = (mpeg1 ? BITRATES.mpeg1 : BITRATES.mpeg2)[bitrateIndex];
  const frameLength = Math.floor((mpeg1 ? 144000 : 72000) * bitrate / sampleRate) + padding;
  if (!Number.isFinite(frameLength) || frameLength < 24 || offset + frameLength > bytes.length + 4) return null;
  return { frameLength, seconds: (mpeg1 ? 1152 : 576) / sampleRate };
}

export function mp3DurationSeconds(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0;
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    offset = Math.min(bytes.length, 10 + synchsafeSize(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0));
  }

  let frames = 0;
  let seconds = 0;
  while (offset + 4 <= bytes.length) {
    const frame = frameInfo(bytes, offset);
    if (!frame) { offset += 1; continue; }
    frames += 1;
    seconds += frame.seconds;
    offset += frame.frameLength;
  }
  if (frames < 2 || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Generated MP3 could not be timed safely (${frames} MPEG frame(s), ${bytes.length} bytes).`);
  }
  return Number(seconds.toFixed(3));
}
