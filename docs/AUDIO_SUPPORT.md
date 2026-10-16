# Audio and SoundFont support

This page describes the audio engines implemented in this checkout. It is a bounded playback feature, not a claim of complete SoundFont or MIDI specification coverage. User-provided banks and external MIDI devices still require acceptance on the target browser and hardware.

## SoundFont 2 bank support

The parser accepts RIFF `sfbk` banks with embedded 16-bit PCM: mono samples (type 1) and reciprocal right/left stereo pairs (types 2/4). Stereo sample links, supported matching rates, each channel's own PCM/loop bounds and instrument membership are validated. Linked channels may have different lengths and relative loop offsets; their ranges are preserved without padding or cropping. Equal PCM lengths are not a requirement in the stereo paragraph of the [SF2 2.04 specification, page 29](https://www.synthfont.com/sfspec24.pdf#page=29). Matching L/R zones are paired one-to-one within their preset/instrument occurrence and key/velocity layer. Both sources share scheduled attack time, note identity and pedal lifecycle; the right-side pitch controls both, while pan, attenuation and envelope parameters remain per channel. If the `ifil` version record is present, it must identify SF2 2.0 through 2.4; when it is absent, the parser defaults the header version to 2.4. The renderer supports a single selected preset, zone key and velocity ranges, root key, coarse/fine tuning plus sample pitch correction, pan, attenuation, attack/hold/decay/sustain/release envelopes, and sample loop modes 0, 1, and 3. Mode 0 plays a one-shot sample; mode 1 loops continuously; mode 3 loops until the key and sustain/sostenuto holds are released, then plays the sample tail. CC 64 sustain, CC 66 selective sostenuto, and CC 67 soft pedal are implemented.

Supported generators inherit instrument/preset global defaults; local values override globals within each level. Preset values add to instrument values before conversion; the resulting key/velocity ranges intersect across those levels. Instrument-global root key is supported; sampleModes is instrument-local only and defaults to one-shot (0). Attenuation is converted from centibels to true dB once; sustain is an amplitude percentage. Canceling future events preserves the current envelope phase. These rules follow SF2 2.04 sections 8.1.2 and 9.4. The parser still ignores `sm24`, preset/instrument modulator tables (`pmod` and `imod`), filters, LFOs, modulation routing, exclusive classes and other unlisted generators. The synth applies its own velocity response and minimum attack/release values; exact commercial-bank timbre parity is not promised.

The following are rejected with an `InvalidSoundFontError` rather than decoded as if they were supported:

- SF3 or a version newer than SF2.04, including Ogg/Vorbis-compressed sample data.
- ROM-backed samples, undefined linkedSample type 8, unknown sample types, malformed/unbalanced stereo pairs, and reserved loop modes.
- Files larger than 1 GiB or too small to contain a valid RIFF header; combined INFO/pdta metadata over 16 MiB; sample rates outside the supported Web Audio range of 3000–384000 Hz.

Choose an uncompressed PCM SF2 bank within this supported subset when one of these errors appears. Unsupported or damaged pairs produce a contextual error instead of being downmixed or silently dropping one channel.

The input limit is **1 GiB**, replacing an application-selected 128 MiB guard; neither value is an inherent SF2/browser file limit. Production loading passes File/Blob directly, indexes RIFF tables in a Worker and reads only referenced PCM ranges. SHA-256 is streamed in a Worker in 4 MiB chunks with pinned `hash-wasm@4.12.0`. Complete bank PCM is not materialized. Buffer-input helpers remain for compatibility and tests.

Live and export share a **256 MiB** decoded/preparing sample budget. Reservations include temporary PCM16 and destination Float32 data during conversion. The inactive LRU target is **64 MiB**; prepared/active buffers are pinned. Capacity failures are explicit, with no missing notes or eviction of sounding buffers. These counters exclude metadata, browser internals, the output audio/video file, and process overhead; 256 MiB is not a whole-tab memory guarantee. One GiB is an accepted input size, not a promise that every bank's simultaneously active sample set fits this budget.

Live playback prepares four song seconds ahead. If the scheduling horizon is not ready, musical time pauses while samples are prepared; explicit Pause/Stop cancels automatic resumption. Seek, replan and output replacement invalidate old work. Offline audio prepares before scheduling into a suspended OfflineAudioContext. Stereo WAV and video use the same synth/provider.

The `handthesia_soundfonts` database version 2 stores immutable Blobs separately from compact metadata. Legacy ArrayBuffer assets migrate transactionally, preserving SHA IDs and selection; list operations on migrated records read metadata only. Save/delete success is reported after transaction completion. The current output stays active until a replacement is prepared, and failed/quota-aborted writes preserve previous data. An export snapshot retains its Blob independently of later output changes or bank deletion. SF2 is not embedded in portable project JSON.

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
