"""Raw SMF event observation and conservative decoded-note mapping."""
from __future__ import annotations

import io
from collections import defaultdict


def observe_source(data: bytes, pm, fixture_id: str) -> dict:
    """Inventory decoded notes and raw events, mapping only unique matches.

    Event ordinals count mido's parsed messages (including meta messages) in
    each original SMF track. Overlapping same-channel/same-pitch note pairs
    are intentionally left unmapped because pairing their raw events would
    otherwise require guessing.
    """
    import mido

    source_notes = []
    for instrument_index, instrument in enumerate(getattr(pm, "instruments", ())):
        for note_index, note in enumerate(instrument.notes):
            source_notes.append({
                "noteId": f"{fixture_id}/instrument-{instrument_index}/note-{note_index:06d}",
                "sourceInstrument": instrument_index,
                "sourceOrdinal": note_index,
                "pitch": int(note.pitch),
                "start": _rounded(note.start),
                "end": _rounded(note.end),
                "velocity": int(note.velocity),
            })

    raw_notes = []
    source_pedals = []
    try:
        midi = mido.MidiFile(file=io.BytesIO(bytes(data)))
    except Exception as exc:
        return {
            "sourceNotes": source_notes,
            "sourcePedals": [],
            "eventBySourceId": {},
            "ambiguousSourceIds": [],
            "rawEventCount": 0,
            "sourceParseErrors": [{
                "phase": "mido source inventory", "type": type(exc).__name__, "message": str(exc),
            }],
        }
    for track_index, track in enumerate(midi.tracks):
        tick = 0
        active = defaultdict(list)
        for event_ordinal, message in enumerate(track):
            tick += int(message.time)
            if (pm is not None and message.type == "control_change"
                    and message.control in (64, 66, 67)):
                source_pedals.append({
                    "track": track_index, "tick": tick,
                    "time": _rounded(pm.tick_to_time(tick)),
                    "controller": int(message.control), "value": int(message.value),
                })
            if message.type == "note_on" and message.velocity > 0:
                key = (int(message.channel), int(message.note))
                record = {
                    "midiTrackIndex": track_index,
                    "channel": int(message.channel),
                    "noteOnOrdinal": event_ordinal,
                    "pitch": int(message.note),
                    "velocity": int(message.velocity),
                    "startTick": tick,
                    "ambiguous": bool(active[key]),
                }
                if active[key]:
                    for prior in active[key]:
                        prior["ambiguous"] = True
                active[key].append(record)
            elif message.type == "note_off" or (message.type == "note_on" and message.velocity == 0):
                key = (int(message.channel), int(message.note))
                if not active[key]:
                    continue
                record = active[key].pop(0)
                record["noteOffOrdinal"] = event_ordinal
                record["endTick"] = tick
                # Keep ambiguous pairs in the candidate inventory. Dropping
                # them here lets a later, clean track incorrectly become the
                # sole pitch/time match for an ambiguous decoded note.
                if pm is not None:
                    record["start"] = _rounded(pm.tick_to_time(record["startTick"]))
                    record["end"] = _rounded(pm.tick_to_time(tick))
                    raw_notes.append(record)

    raw_by_signature = defaultdict(list)
    ambiguous_pitch_velocities = {
        (item["pitch"], item["velocity"]) for item in raw_notes if item["ambiguous"]
    }
    for item in raw_notes:
        signature = (item["pitch"], item["velocity"], round(item["start"], 5), round(item["end"], 5))
        raw_by_signature[signature].append(item)

    event_by_source_id = {}
    ambiguous_source_ids = set()
    decoded_by_signature = defaultdict(list)
    for item in source_notes:
        signature = (item["pitch"], item["velocity"], round(item["start"], 5), round(item["end"], 5))
        decoded_by_signature[signature].append(item)
    for item in source_notes:
        signature = (item["pitch"], item["velocity"], round(item["start"], 5), round(item["end"], 5))
        candidates = raw_by_signature.get(signature, [])
        # A locator is safe only when one decoded note and one non-overlapped
        # raw pair share the signature. Never use first-consumer-wins matching.
        if (len(decoded_by_signature[signature]) == 1 and len(candidates) == 1
                and not candidates[0]["ambiguous"]):
            raw = candidates[0]
            event_by_source_id[item["noteId"]] = {
                key: raw[key] for key in (
                    "midiTrackIndex", "channel", "noteOnOrdinal", "noteOffOrdinal")
            }
        elif (candidates or len(decoded_by_signature[signature]) > 1
              or (item["pitch"], item["velocity"]) in ambiguous_pitch_velocities):
            ambiguous_source_ids.add(item["noteId"])

    for item in source_notes:
        raw = event_by_source_id.get(item["noteId"])
        if raw:
            item["sourceEvent"] = dict(raw)

    return {
        "sourceNotes": source_notes,
        "sourcePedals": sorted(source_pedals, key=lambda e: (e["time"], e["track"], e["tick"])),
        "eventBySourceId": event_by_source_id,
        "ambiguousSourceIds": sorted(ambiguous_source_ids),
        "rawEventCount": sum(len(track) for track in midi.tracks),
        "sourceParseErrors": [],
    }


def _rounded(value, digits=8):
    result = round(float(value), digits)
    return 0.0 if result == 0 else result

