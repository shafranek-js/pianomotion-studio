# Local user-bank acceptance — 2026-10-16, dev.6

Canonical checkout: `C:\Projects\pianomotion-studio`. Eight files in the private, Git-ignored `soundfonts/` directory were inspected read-only. They are not application assets, repository fixtures or deployment contents. Original byte hashes are checked before and after browser acceptance.

## Repairs

The parser previously discarded instrument/preset global generators. Supported values now inherit globals, with local overrides at the same level; preset relative values add to instrument values before conversion. Key/velocity ranges use local-over-global precedence and then intersect across preset/instrument levels. Instrument-global root key is supported. SampleModes is local-only; its absence means no loop, regardless of header loop bounds. These distinctions were checked independently against [SF2 2.04 sections 8.1.2 and 9.4](https://www.synthfont.com/sfspec24.pdf).

Attenuation converts centibels to real dB once; coarse/fine tuning preserves sample-header correction. Volume envelopes honor hold, decay and sustain in addition to attack/release. Future-event cancellation resumes the current phase without a new attack. The shared synth applies these changes to live and offline audio.

Parser regressions: 18/18; synth regressions: 16/16; root full unit run: 454/454 across 35 files. Root typecheck and lint passed. Python passed 31 tests including the 13 frozen goldens; native Chrome parity passed 15/15. Both Chrome and Edge passed native WAV, MP4 and WebM stereo encode/demux/decode (`stereo-export-chrome.json`, `stereo-export-msedge.json`). Production offline restoration of the Blob bank and parser/hash Workers passed at root and project base paths; see the adjacent built-in melody report.

## Bank results

| Input | Chrome | Edge | Classification |
| --- | --- | --- | --- |
| Abbey-Steinway-D-v1.9.sf2 | PASS | PASS | Valid linked stereo SF2 |
| Chateau-Grand-v2.2.sf2 | PASS | PASS | Valid linked stereo SF2 |
| Nice-Steinway-Lite-v3.0.sf2 | PASS | PASS | Valid linked stereo SF2 |
| Nice-Steinway-v3.8.sf2 | PASS | PASS | Valid linked stereo SF2 |
| NY-Steinway-Model-B-v5.2.sf2 | PASS | PASS | Valid linked stereo SF2 |
| YDP-GrandPiano-20160804.sf2 | PASS | PASS | Valid mono SF2 |
| Fazioli-F308-v2.6.sf2 | Rejected as expected | Rejected as expected | Malformed active stereo link; not a working bank |
| MuseScore_General.sf3 | Rejected as expected | Rejected as expected | Unsupported compressed SF3; not a working bank |

Each positive case imports through the actual Settings UI and parser/hash Workers, activates the backend, advances playback beyond lead-in, saves/reloads and restores the selected asset. OfflineAudioContext renders nine low/mid/high pitch/velocity probes plus a scheduled sustain/release sequence. Both output channels must contain finite non-silent samples, peak magnitude must not exceed 1.000001, voice cleanup must complete and the shared decoded/preparing budget must remain within 256 MiB. This is software acceptance, not subjective timbre comparison.

Chrome observed peaks span 0.287–0.410 for these probes; measured decoded working sets span 24.66–66.87 MiB. These are specific probe measurements, not a bound for arbitrary scores or all presets. `chrome.json` contains the actual native report and `chrome-metrics.json` the decoded attachments. Both Chrome and Edge passed all eight cases: six working-bank checks and two explicit rejection/output-preservation checks. `msedge.json` and `msedge-metrics.json` retain the independent Edge run.

## Rejected inputs and remaining limits

Fazioli SHA-256: `bba52410c7ad5736aab67c3b27889819bc9b1c9995e0a22b68bec1071289984b`. Sample 287 (`C214 XY-R PD f D#6-L`, type 4/left) links to 288 (`C214 XY-R PD f D#6-R`), but 288 declares type 1/mono and link 0. All four presets reference the damaged pair. Equal length/rate does not supply a valid reciprocal channel declaration. The application deliberately rejects it with the sample name; it does not guess a replacement channel, alter the bank or silently downmix it. Failed import preserves the active output and does not install an asset.

MuseScore General contains compressed Ogg/Vorbis sample data and declares major version 3. The current engine implements PCM SF2 only and returns an explicit SF3 error. Adding a compressed-sample decoder and resource policy is a separate feature; renaming the file does not convert it.

Filters, LFO/modulator routing, reverb/chorus, exclusive classes, `sm24` and other unlisted SF2 features remain outside the implemented subset; several tested banks contain such operators. Chateau includes four nonterminal instrument modulator records. Passing these probes does not establish exact FluidSynth/commercial-player timbre parity, every preset, every pitch/velocity combination or arbitrary dense-polyphony support. See [AUDIO_SUPPORT](../../AUDIO_SUPPORT.md). No bank bytes were committed or deployed.
