const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function chunk(tag: string, data: Uint8Array): Uint8Array {
  const paddedLength = data.byteLength + (data.byteLength % 2);
  const result = new Uint8Array(8 + paddedLength);
  result.set(encoder.encode(tag), 0);
  new DataView(result.buffer).setUint32(4, data.byteLength, true);
  result.set(data, 8);
  return result;
}

function list(type: string, chunks: Uint8Array[]): Uint8Array {
  return chunk("LIST", concat([encoder.encode(type), ...chunks]));
}

function textField(target: Uint8Array, offset: number, length: number, text: string): void {
  target.set(encoder.encode(text).subarray(0, length), offset);
}

export interface SyntheticStereoSf2Options {
  sampleRate?: number;
  seconds?: number;
  frequency?: number;
  rightPhaseRadians?: number;
  rightGain?: number;
}

/** Builds a small linked LEFT/RIGHT SF2 pair with distinct channel phase for browser export checks. */
export function createSyntheticStereoSf2(options: SyntheticStereoSf2Options = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 22_050;
  const seconds = options.seconds ?? 0.75;
  const frequency = options.frequency ?? 440;
  const rightPhaseRadians = options.rightPhaseRadians ?? Math.PI / 2;
  const rightGain = options.rightGain ?? 0.68;
  const sampleCount = Math.max(256, Math.round(sampleRate * seconds));
  const pcm = new Uint8Array(sampleCount * 2 * 2);
  const pcmView = new DataView(pcm.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const left = Math.round(Math.sin(2 * Math.PI * frequency * time) * 24_000);
    const right = Math.round(Math.sin(2 * Math.PI * frequency * time + rightPhaseRadians) * 24_000 * rightGain);
    pcmView.setInt16(index * 2, left, true);
    pcmView.setInt16((sampleCount + index) * 2, right, true);
  }

  const version = new Uint8Array(4);
  const versionView = new DataView(version.buffer);
  versionView.setUint16(0, 2, true);
  versionView.setUint16(2, 4, true);

  const sampleHeaders = new Uint8Array(46 * 3);
  const sampleView = new DataView(sampleHeaders.buffer);
  textField(sampleHeaders, 0, 20, "Stereo Left A4");
  sampleView.setUint32(20, 0, true);
  sampleView.setUint32(24, sampleCount, true);
  sampleView.setUint32(28, 0, true);
  sampleView.setUint32(32, sampleCount, true);
  sampleView.setUint32(36, sampleRate, true);
  sampleView.setUint8(40, 69);
  sampleView.setUint16(42, 1, true);
  sampleView.setUint16(44, 4, true); // sampleType 4 = LEFT.

  const rightHeaderOffset = 46;
  textField(sampleHeaders, rightHeaderOffset, 20, "Stereo Right A4");
  sampleView.setUint32(rightHeaderOffset + 20, sampleCount, true);
  sampleView.setUint32(rightHeaderOffset + 24, sampleCount * 2, true);
  sampleView.setUint32(rightHeaderOffset + 28, sampleCount, true);
  sampleView.setUint32(rightHeaderOffset + 32, sampleCount * 2, true);
  sampleView.setUint32(rightHeaderOffset + 36, sampleRate, true);
  sampleView.setUint8(rightHeaderOffset + 40, 69);
  sampleView.setUint16(rightHeaderOffset + 42, 0, true);
  sampleView.setUint16(rightHeaderOffset + 44, 2, true); // sampleType 2 = RIGHT.

  const eosOffset = 46 * 2;
  textField(sampleHeaders, eosOffset, 20, "EOS");
  sampleView.setUint16(eosOffset + 44, 0x8000, true);

  const presetHeaders = new Uint8Array(38 * 2);
  const presetView = new DataView(presetHeaders.buffer);
  textField(presetHeaders, 0, 20, "Synthetic Stereo 440");
  presetView.setUint16(24, 0, true);
  textField(presetHeaders, 38, 20, "EOP");
  presetView.setUint16(38 + 24, 1, true);

  const presetBags = new Uint8Array(4 * 2);
  new DataView(presetBags.buffer).setUint16(4, 1, true);
  const presetGenerators = new Uint8Array(4);
  const presetGeneratorView = new DataView(presetGenerators.buffer);
  presetGeneratorView.setUint16(0, 41, true); // instrument
  presetGeneratorView.setUint16(2, 0, true);

  const instruments = new Uint8Array(22 * 2);
  const instrumentView = new DataView(instruments.buffer);
  textField(instruments, 0, 20, "Synthetic Stereo Instrument");
  instrumentView.setUint16(20, 0, true);
  textField(instruments, 22, 20, "EOI");
  instrumentView.setUint16(42, 2, true);

  const instrumentBags = new Uint8Array(3 * 4);
  const instrumentBagView = new DataView(instrumentBags.buffer);
  instrumentBagView.setUint16(4, 3, true);
  instrumentBagView.setUint16(8, 6, true);

  const instrumentGenerators = new Uint8Array(12 * 2);
  const instrumentGeneratorView = new DataView(instrumentGenerators.buffer);
  instrumentGeneratorView.setUint16(0, 54, true); // sampleModes = loop while key down
  instrumentGeneratorView.setUint16(2, 3, true);
  instrumentGeneratorView.setUint16(4, 17, true); // pan = hard left in SF2 units
  instrumentGeneratorView.setInt16(6, -500, true);
  instrumentGeneratorView.setUint16(8, 53, true); // sampleID = linked left sample
  instrumentGeneratorView.setUint16(10, 0, true);
  instrumentGeneratorView.setUint16(12, 54, true);
  instrumentGeneratorView.setUint16(14, 3, true);
  instrumentGeneratorView.setUint16(16, 17, true); // pan = hard right in SF2 units
  instrumentGeneratorView.setInt16(18, 500, true);
  instrumentGeneratorView.setUint16(20, 53, true); // sampleID = linked right sample
  instrumentGeneratorView.setUint16(22, 1, true);

  return chunk("RIFF", concat([
    encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version), chunk("INAM", encoder.encode("Synthetic Stereo SF2"))]),
    list("sdta", [chunk("smpl", pcm)]),
    list("pdta", [
      chunk("phdr", presetHeaders),
      chunk("pbag", presetBags),
      chunk("pgen", presetGenerators),
      chunk("inst", instruments),
      chunk("ibag", instrumentBags),
      chunk("igen", instrumentGenerators),
      chunk("shdr", sampleHeaders),
    ]),
  ]));
}
