import { createSyntheticMonoSf2 } from "../../../apps/client/src/audio/soundfont/testing/syntheticMonoSf2";

// Actual PCM bank: A4 sample root for three deliberately non-GM sine timbres.
// Frequencies distinguish bank selection from both piano GM0 and oscillator A440.
export function createGmBank(): Uint8Array {
  const encoder = new TextEncoder();
  const concat = (parts: Uint8Array[]) => {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of parts) { result.set(part, position); position += part.length; }
    return result;
  };
  const chunk = (tag: string, data: Uint8Array) => {
    const result = new Uint8Array(8 + data.length + data.length % 2);
    result.set(encoder.encode(tag));
    new DataView(result.buffer).setUint32(4, data.length, true);
    result.set(data, 8);
    return result;
  };
  const list = (tag: string, parts: Uint8Array[]) => chunk("LIST", concat([encoder.encode(tag), ...parts]));
  const table = (size: number) => new Uint8Array(size);
  const name = (target: Uint8Array, offset: number, text: string) => target.set(encoder.encode(text).subarray(0, 20), offset);
  const programs = [0, 40, 42];
  const pcm: Uint8Array[] = [];
  const phdr = table(38 * 4), pbag = table(4 * 4), pgen = table(4 * 3);
  const inst = table(22 * 4), ibag = table(4 * 4), igen = table(8 * 3), shdr = table(46 * 4);
  const views = [phdr, pbag, pgen, inst, ibag, igen, shdr].map(bytes => new DataView(bytes.buffer));
  const [pv, pbv, pgv, iv, ibv, igv, sv] = views;
  let sampleOffset = 0;
  for (let index = 0; index < programs.length; index++) {
    const source = createSyntheticMonoSf2({ frequency: [220, 660, 990][index], seconds: 0.2 });
    const marker = encoder.encode("smpl");
    const offset = source.findIndex((_, i) => marker.every((value, j) => source[i + j] === value));
    const length = new DataView(source.buffer).getUint32(offset + 4, true);
    const data = source.slice(offset + 8, offset + 8 + length);
    pcm.push(data);
    name(phdr, index * 38, `GM ${programs[index]}`);
    pv!.setUint16(index * 38 + 20, programs[index]!, true);
    pv!.setUint16(index * 38 + 24, index, true);
    pbv!.setUint16(index * 4, index, true);
    pgv!.setUint16(index * 4, 41, true); // instrument
    pgv!.setUint16(index * 4 + 2, index, true);
    name(inst, index * 22, `Sine ${index}`);
    iv!.setUint16(index * 22 + 20, index, true);
    ibv!.setUint16(index * 4, index * 2, true);
    igv!.setUint16(index * 8, 54, true); // loop while held
    igv!.setUint16(index * 8 + 2, 3, true);
    igv!.setUint16(index * 8 + 4, 53, true); // sample
    igv!.setUint16(index * 8 + 6, index, true);
    name(shdr, index * 46, `Sine ${index}`);
    for (const [position, value] of [[20, sampleOffset], [24, sampleOffset + length / 2], [28, sampleOffset], [32, sampleOffset + length / 2], [36, 22_050]]) {
      sv!.setUint32(index * 46 + position!, value!, true);
    }
    sv!.setUint8(index * 46 + 40, 69);
    sv!.setUint16(index * 46 + 44, 1, true);
    sampleOffset += length / 2;
  }
  name(phdr, 114, "EOP"); pv!.setUint16(138, 3, true); pbv!.setUint16(12, 3, true);
  name(inst, 66, "EOI"); iv!.setUint16(86, 3, true); ibv!.setUint16(12, 6, true);
  name(shdr, 138, "EOS"); sv!.setUint16(182, 0x8000, true);
  const version = new Uint8Array([2, 0, 4, 0]);
  return chunk("RIFF", concat([encoder.encode("sfbk"),
    list("INFO", [chunk("ifil", version), chunk("INAM", encoder.encode("Synthetic GM backing"))]),
    list("sdta", [chunk("smpl", concat(pcm))]),
    list("pdta", [chunk("phdr", phdr), chunk("pbag", pbag), chunk("pgen", pgen), chunk("inst", inst), chunk("ibag", ibag), chunk("igen", igen), chunk("shdr", shdr)]),
  ]));
}
