# Fazioli F308 v3.0 stereo repair

The downloaded v3.0 bank had one malformed stereo sample header pair. A separate repair copy now has a reciprocal left/right link, while the downloaded v3.0 and the existing v2.6 bank remain unchanged. This is file-level metadata verification; browser playback and listening acceptance are tracked separately by the parent task.

## Source and provenance

The v3.0 bank was downloaded from the Google Drive file linked by the [SoundFonts 4U Recreated page](https://nullcrawler.uk/pages/misc/soundfonts4u_recreate/home.html). That page identifies the Fazioli F308 v3.0 entry and says it fixes a fade issue. The page also states that it is a recreation of the original site, not the original site's owner. The linked file is therefore recorded as an archive-provided v3.0 copy, not independently authenticated as a fresh author-hosted download. The download URL was `https://drive.google.com/file/d/1sI-fk7RmQwAuIUTsH_z-cceEFAmj03nx/view`.

Jonky Ponky's [MuseScore release post](https://musescore.org/en/node/329283) says Dore Mark permitted conversion of the sampled F308 for SF2, and gives the v2.6 Drive link. A later [MuseScore post](https://musescore.org/en/node/345265) says the SF2 version was available from Jonky Ponky's site and that Dore Mark approved its release. The [SoundFonts4U archive listing](https://huggingface.co/datasets/projectlosangeles/soundfonts4u) includes v2.6, but its current file list does not include v3.0.

The local v2.6 bank's SHA-256 matches the v2.6 file in that public mirror (`bba52410c7ad5736aab67c3b27889819bc9b1c9995e0a22b68bec1071289984b`). Both the archived Drive-linked v3.0 file and that byte-matching v2.6 bank contain the same malformed right-channel header. This supports an upstream-published metadata defect rather than a damaged local transfer. It does not establish whether the original author's v3.0 source had the same defect, because a direct author-hosted v3.0 file was not available to compare.

## Header evidence and repair

Both samples have unique names and matching 161,448-frame, 48 kHz sample bounds. Their references are present in the same instruments and in all four presets: `Fazioli Grand F308`, `Fazioli Dynamic`, `Fazioli Dark`, and `Fazioli Extra Dark`.

| `shdr` index | Name | Before: type/link | After: type/link |
| --- | --- | --- | --- |
| 287 | `C214 XY-R PD f D#6-L` | left / 4, link 288 | left / 4, link 288 |
| 288 | `C214 XY-R PD f D#6-R` | mono / 1, link 0 | right / 2, link 287 |

The `shdr` table starts at file offset `313718728`. The only edits are two little-endian 16-bit values in record 288: `sampleLink` at offset `313732018`, from 0 to 287, and `sampleType` at offset `313732020`, from 1 to 2. The repair utility requires the exact v3.0 file size and SHA-256, rechecks the original fields while copying, refuses to overwrite any output, and validates the repaired pair and preset coverage. It verifies that the resulting `shdr` table differs only at those two authorized fields.

| File | SHA-256 | Size |
| --- | --- | ---: |
| Retained downloaded source: [`Fazioli-F308-v3.0.sf2`](../../../soundfonts/Fazioli-F308-v3.0.sf2) | `db1b7d2ecd5c8a68594f03687c51811e3c944b35be4c5bc081f2aba217252fbb` | 313,732,114 bytes |
| Separate repair copy: [`Fazioli-F308-v3.0.repaired.sf2`](../../../soundfonts/Fazioli-F308-v3.0.repaired.sf2) | `596663ff22f3fca38c2ebec4e6d24cb8824c188a3295d93a875a327f59a9a430` | 313,732,114 bytes |

The original v2.6 bank was not modified, and no v2.6 repair copy was created. The repair tool is [`repair-fazioli-stereo.mjs`](../../../tools/repair-fazioli-stereo.mjs). Its focused tests pass: `node --test tools/repair-fazioli-stereo.test.mjs` (5 passed).
