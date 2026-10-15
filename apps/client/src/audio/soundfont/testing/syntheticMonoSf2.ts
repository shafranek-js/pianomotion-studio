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

/** Builds a tiny, complete mono-PCM SF2 bank for real browser parser/output tests. */
export function createSyntheticMonoSf2(options: { sampleRate?: number; seconds?: number; frequency?: number } = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 22_050;
  const seconds = options.seconds ?? 0.5;
  const frequency = options.frequency ?? 440;
  const sampleCount = Math.max(128, Math.round(sampleRate * seconds));
  const pcm = new Uint8Array(sampleCount * 2);
  const pcmView = new DataView(pcm.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 19_000);
    pcmView.setInt16(index * 2, sample, true);
  }

  const version = new Uint8Array(4);
  const versionView = new DataView(version.buffer);
  versionView.setUint16(0, 2, true);
  versionView.setUint16(2, 4, true);

  const sampleHeaders = new Uint8Array(46 * 2);
  const sampleView = new DataView(sampleHeaders.buffer);
  textField(sampleHeaders, 0, 20, "Synthetic A4");
  sampleView.setUint32(20, 0, true);
  sampleView.setUint32(24, sampleCount, true);
  sampleView.setUint32(28, 0, true);
  sampleView.setUint32(32, sampleCount, true);
  sampleView.setUint32(36, sampleRate, true);
  sampleView.setUint8(40, 69); // A4 is the sample root key.
  sampleView.setUint16(44, 1, true); // SF2 sample type 1 = mono.
  const eos = 46;
  textField(sampleHeaders, eos, 20, "EOS");
  sampleView.setUint16(eos + 44, 0x8000, true);

  const presetHeaders = new Uint8Array(38 * 2);
  const presetView = new DataView(presetHeaders.buffer);
  textField(presetHeaders, 0, 20, "Synthetic 440");
  presetView.setUint16(24, 0, true); // First preset zone uses pbag 0.
  textField(presetHeaders, 38, 20, "EOP");
  presetView.setUint16(38 + 24, 1, true); // Terminal preset header.

  const presetBags = new Uint8Array(4 * 2);
  new DataView(presetBags.buffer).setUint16(4, 1, true);
  const presetGenerators = new Uint8Array(4);
  const presetGeneratorView = new DataView(presetGenerators.buffer);
  presetGeneratorView.setUint16(0, 41, true); // instrument
  presetGeneratorView.setUint16(2, 0, true);

  const instruments = new Uint8Array(22 * 2);
  const instrumentView = new DataView(instruments.buffer);
  textField(instruments, 0, 20, "Synthetic Instrument");
  instrumentView.setUint16(20, 0, true);
  textField(instruments, 22, 20, "EOI");
  instrumentView.setUint16(42, 1, true);

  const instrumentBags = new Uint8Array(4 * 2);
  new DataView(instrumentBags.buffer).setUint16(4, 2, true);
  const instrumentGenerators = new Uint8Array(4 * 2);
  const instrumentGeneratorView = new DataView(instrumentGenerators.buffer);
  instrumentGeneratorView.setUint16(0, 54, true); // sampleModes = loop while held
  instrumentGeneratorView.setUint16(2, 3, true);
  instrumentGeneratorView.setUint16(4, 53, true); // sampleID = first shdr
  instrumentGeneratorView.setUint16(6, 0, true);

  const bank = chunk("RIFF", concat([
    encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version), chunk("INAM", encoder.encode("Synthetic Mono SF2"))]),
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
  return bank;
}
