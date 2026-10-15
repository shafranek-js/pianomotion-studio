# Audio and SoundFont support

This page describes the audio engines implemented in this checkout. It is a bounded playback feature, not a claim of complete SoundFont or MIDI specification coverage. User-provided banks and external MIDI devices still require acceptance on the target browser and hardware.

## SoundFont 2 bank support

The parser accepts RIFF `sfbk` banks with embedded 16-bit mono PCM sample data. If the `ifil` version record is present, it must identify SF2 2.0 through 2.4; when it is absent, the parser defaults the header version to 2.4. It reads the preset, instrument, bag, generator, and sample-header tables needed to select playable zones. The renderer supports a single selected preset, zone key and velocity ranges, root key, pitch correction, pan, attack and release time, and sample loop modes 0, 1, and 3. Mode 0 plays a one-shot sample; mode 1 loops continuously; mode 3 loops until the key and sustain/sostenuto holds are released, then plays the sample tail. CC 64 sustain, CC 66 selective sostenuto, and CC 67 soft pedal are implemented.

The parser currently ignores `sm24`, preset/instrument modulator tables (`pmod` and `imod`), global-zone generator inheritance, and generator operators other than the listed zone fields. This means attenuation, coarse tuning, filters, LFOs, modulation routing, hold/decay/sustain envelope stages, exclusive classes, and other unlisted generators do not affect playback. They may be ignored even when present in a bank. The synth applies its own velocity response and minimum attack/release values; exact commercial-bank timbre parity is not promised.

The following are rejected with an `InvalidSoundFontError` rather than decoded as if they were supported:

- SF3 or a version newer than SF2.04, including Ogg/Vorbis-compressed sample data.
- ROM-backed samples, stereo/linked sample types, unknown non-mono sample types, and reserved loop modes.
- Files larger than 128 MiB or too small to contain a valid RIFF header.

Choose an uncompressed SF2 bank with embedded mono PCM when one of these errors appears. This early rejection is deliberate; the parser is not a generic audio-file decoder.

The upload limit is 128 MiB for the bank file. Decoded sample buffers use a 64 MiB least-recently-used target for inactive samples. Buffers referenced by active voices are pinned and cannot be evicted, so the decoded cache can exceed 64 MiB while many or large samples are active. The parsed PCM, the caller's bank bytes, worker transfer copies, browser audio buffers, and IndexedDB storage are separate allocations; these limits are not a total-process or peak-memory guarantee. Default `parseSf2Async` preserves the caller's bytes by cloning the transferable input. Passing `transferInput: true` transfers and detaches an `ArrayBuffer`; `Uint8Array` views are copied to a plain transferable buffer.

SF2 loading is prepared as a new output candidate. The current output remains active until parsing and preparation succeed, after which the transport can replace and dispose the previous output. Offline video rendering can receive the parsed `Sf2SoundFont` and uses the same performance plan, synth, sample bank, and master-volume stage; export without a selected SF2 uses the built-in synth instead.

## Recording time stretch

Live synchronized recordings and offline recording exports use the locally vendored Signalsmith Stretch Web 1.3.2 WASM/AudioWorklet release. The live path changes playback rate while requesting zero semitone shift; unavailable AudioWorklet/WASM support is surfaced as an audio preparation or playback error rather than falling back to varispeed. Input channels are resampled to the audio-context sample rate before the stretch node receives them, and the song-to-recording offset is applied once.

The vendored `SignalsmithStretch.mjs` is byte-identical to the locally installed `signalsmith-stretch@1.3.2` distribution: SHA-256 `97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46`. The source, upstream README, and complete MIT notice are retained under `apps/client/src/audio/vendor/signalsmith-stretch-1.3.2/`; the corresponding public notice is under `apps/client/public/notices/`. Production imports the local module, so this copy does not rely on a runtime CDN or the removed npm dependency.

Final seven-speed measurements are in `docs/evidence/audit-repair-2026-10-15/audio-dsp-chrome.json` and `audio-dsp-msedge.json`; the earlier `audio-dsp.json` is an intermediate four-speed run. Both installed Windows channels passed the real local AudioWorklet test under the production CSP, SF2 modes 0/1/3 and 100 sequential notes. Across the final two runs, pitch error stayed below 3 cents and marker error was at most 7.5 ms. The real synthetic RIFF bank was also uploaded through Settings, parsed in a Worker, activated, and recovered after reload. This is headless browser evidence, not acceptance with a user's bank or subjective listening.

Recording playback uses an intent generation so a late stop RPC cannot overwrite a newer seek or tempo change. Native SoundFont offline rendering checks cancellation at bounded suspension points, disposes voices and awaits the render promise before rejecting. `OfflineAudioContext` has no native cancel/close method: cancellation settles the native render rather than promising instantaneous termination of that context.

## Web MIDI output

Web MIDI sends MIDI 1 channel voice messages on the selected output and configured channel (UI channels 1–16, represented internally as 0–15). The implemented messages are Note On, Note Off, CC 64/66/67 pedal state, and CC 7 channel volume. Scheduled Web Audio times are translated to Web MIDI timestamps using the performance clock. Permission requests use `sysex: false` and are initiated only by the explicit Settings connect gesture; Player initialization checks/reuses an existing grant and does not open a permission prompt. Disconnects are observable playback failures and stop the transport.

This path does not provide MIDI input, SysEx, MIDI 2.0, instrument-bank selection, or a guarantee that a device interprets the supported controllers like the built-in synth. Physical device latency and sound depend on the browser, operating system, MIDI interface, channel, and receiving instrument.

## Remaining acceptance gates

Automated unit and synthetic-browser tests establish implementation behavior only. Manual acceptance is still required with representative user SF2 banks and real MIDI hardware in supported Chrome/Edge configurations. Verify bank compatibility messages, selected preset and channel, pedal and volume interpretation, startup latency, disconnection/reconnection behavior, and recording/video synchronization. No physical MIDI-device or user-bank acceptance is claimed by this document.
