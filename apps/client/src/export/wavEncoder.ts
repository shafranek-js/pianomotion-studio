/**
 * Interface representing standard AudioBuffer channel access.
 */
export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Encodes an AudioBuffer (or AudioBufferLike) into a standard 16-bit linear PCM RIFF WAV byte array.
 */
export function encodeAudioBufferToWav(buffer: AudioBufferLike): Uint8Array {
  const numChannels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const totalSize = 44 + dataSize;

  const wav = new Uint8Array(totalSize);
  const view = new DataView(wav.buffer);

  // RIFF Chunk Descriptor
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeAscii(wav, 8, "WAVE");

  // "fmt " Subchunk
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // "data" Subchunk
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataSize, true); // Subchunk2Size

  // Interleave and write 16-bit samples
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = channelData[ch]![i] ?? 0;
      // Clamp float32 [-1.0, 1.0] to signed 16-bit int [-32768, 32767]
      const clamped = Math.max(-1.0, Math.min(1.0, sample));
      const intSample = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return wav;
}

/**
 * Encodes an AudioBuffer into a downloadable audio/wav Blob.
 */
export function audioBufferToWavBlob(buffer: AudioBufferLike): Blob {
  const bytes = encodeAudioBufferToWav(buffer);
  return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    target[offset + i] = text.charCodeAt(i);
  }
}
