# Desktop baseline fixtures

This directory contains 13 deterministic inputs for the W001/W004/W005 M0 web-migration baseline. Three MIDI files are byte-for-byte copies of the tracked desktop examples; their original source paths, original SHA-256 values, fixture hashes, and generated synthetic fixture hashes are recorded in [`manifest.json`](manifest.json). The other ten files are synthetic SMFs written locally by [`generate_desktop_baseline.py`](../../tools/generate_desktop_baseline.py). No third-party MIDI, PIG, profile, recording, font, or audio data is used.

The fixtures cover the three tracked examples, scale and chord material, duplicate same-pitch/same-onset notes on separate tracks, tempo changes, overlapping notes, sustain/sostenuto/soft pedals and the sustain threshold, manual finger and gliss markers, track-label/register disagreement, alternating crossings plus a six-note chord, 512-note stress input, and empty, truncated, and non-MIDI inputs.

Each golden JSON is an observation of the desktop loader, assignment, performance, and selected animation output at the source SHA in the manifest. Stable IDs are assigned after PrettyMIDI decodes each instrument: `fixture/instrument-N/note-NNNNNN`. They are not raw SMF event IDs. The current desktop pipeline does not provide a mapping from decoded notes to raw MIDI note-on/note-off events; the M1 identity adapter must define that mapping. Where desktop sanitization merges notes, `sourceNoteIds` records the decoded-note ordinals involved and `identityLosses` makes the merge explicit.

`loaded` means only that `midi_loader.load_midi` returned a `Song`; it does not claim that the UI accepts the song as playable. `repaired` records the loader salvaging the intentionally truncated input, including the exact cleanup message. `invalid-or-rejected` records inputs rejected before a `Song` was returned.

Golden poses include every bone endpoint and joint position, finger chains, the keyboard-relative screen-pixel coordinate frame, pixels-per-inch, and the crossing layer returned by `hands.arrange_crossing` for paired common timestamps. Goldens are desktop observations, not independent correctness oracles.
