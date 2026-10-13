from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[3]
CORE_ROOT = REPO / "web" / "python-core"
FIXTURES = REPO / "web" / "tests" / "fixtures"
if str(CORE_ROOT) not in sys.path:
    sys.path.insert(0, str(CORE_ROOT))

from handthesia_core import api  # noqa: E402


PROFILE = api._default_profile_dto()


def _analysis(source_bytes: bytes, fixture_id: str, *, profile=None, key_style="realistic"):
    manifest = api._manifest()
    result = api.analyze_midi(source_bytes, {
        "fixtureId": fixture_id,
        "projectId": "replan-test-project",
        "revision": 1,
        "requestId": f"analysis-{fixture_id}-{key_style}",
        "engineVersion": api._engine_version(manifest),
        "profile": profile,
        "keyStyle": key_style,
    })
    return result


def _replan_options(analysis, request_id: str, *, profile=None, key_style="realistic"):
    profile = profile or analysis["profile"]
    plan = copy.deepcopy(analysis["fingeringPlan"])
    plan["profileId"] = profile["profileId"]
    plan["profileRevision"] = profile["revision"]
    return plan, {
        "fixtureId": analysis["rawBaseline"]["fixtureId"],
        "projectId": analysis["projectId"],
        "revision": analysis["revision"],
        "requestId": request_id,
        "engineVersion": analysis["engineVersion"],
        "profile": profile,
        "keyStyle": key_style,
        "resource": analysis["resource"],
        "rawBaseline": analysis["rawBaseline"],
    }


LOADED_FIXTURES = [
    "synthetic-crossing-wide-chord.mid",
    "synthetic-duplicate-identities.mid",
    "synthetic-manual-fingering-gliss.mid",
    "synthetic-mismatched-track-labels.mid",
    "synthetic-scale-chords.mid",
    "synthetic-stress-512.mid",
    "synthetic-tempo-pedals-overlap.mid",
    "tracked-demo-song.mid",
    "tracked-right-hand.mid",
    "tracked-right-hand-octaves.mid",
]


def test_noop_typed_replan_preserves_full_source_document_and_baseline():
    for fixture_name in LOADED_FIXTURES:
        source_bytes = (FIXTURES / "midi" / fixture_name).read_bytes()
        fixture_id = fixture_name.removesuffix(".mid")
        analysis = _analysis(source_bytes, fixture_id)
        assert analysis["status"] in ("loaded", "repaired")

        original_document = copy.deepcopy(analysis["document"])
        original_resource = copy.deepcopy(analysis["resource"])
        original_baseline = copy.deepcopy(analysis["rawBaseline"])
        original_ids = [note["noteId"] for note in original_document["notes"]]
        plan, options = _replan_options(analysis, f"replan-noop-{fixture_id}")

        result = api.replan_document(source_bytes, original_document, plan, options)

        assert result["document"] == original_document
        compact_result = json.dumps(result["document"], separators=(",", ":"))
        compact_original = json.dumps(original_document, separators=(",", ":"))
        assert compact_result == compact_original
        assert result["resource"] == original_resource
        assert result["rawBaseline"] == original_baseline
        assert [note["noteId"] for note in result["document"]["notes"]] == original_ids
        assert result["status"] == analysis["status"]


def test_profile_and_key_style_replan_is_deterministic_a_b_a():
    fixture_id = "synthetic-scale-chords"
    source_bytes = (FIXTURES / "midi" / f"{fixture_id}.mid").read_bytes()
    profile_a = copy.deepcopy(PROFILE)
    profile_a["profileId"] = "profile-a"
    profile_a["revision"] = 3
    base = _analysis(source_bytes, fixture_id, profile=profile_a, key_style="realistic")
    document = copy.deepcopy(base["document"])

    plan_a, options_a = _replan_options(base, "profile-a-first", profile=profile_a, key_style="realistic")
    result_a = api.replan_document(source_bytes, document, plan_a, options_a)

    profile_b = copy.deepcopy(profile_a)
    profile_b["profileId"] = "profile-b"
    profile_b["revision"] = 7
    profile_b["name"] = "Alternate profile"
    profile_b["anatomy"] = {**profile_b["anatomy"], "fingerLengthInches": profile_b["anatomy"].get("fingerLengthInches", 3.0) + 0.2}
    plan_b, options_b = _replan_options(result_a, "profile-b-equal", profile=profile_b, key_style="equal")
    result_b = api.replan_document(source_bytes, result_a["document"], plan_b, options_b)
    assert result_b["profile"] == profile_b
    assert result_b["keyStyle"] == "equal"
    assert result_b["motionPlan"]["poses"] != result_a["motionPlan"]["poses"]

    plan_a_again, options_a_again = _replan_options(result_b, "profile-a-again", profile=profile_a, key_style="realistic")
    result_a_again = api.replan_document(source_bytes, result_b["document"], plan_a_again, options_a_again)
    assert result_a_again["profile"] == profile_a
    assert result_a_again["keyStyle"] == "realistic"
    assert result_a_again["document"] == result_a["document"]
    for key in ("fingeringPlan", "performancePlan", "motionPlan"):
        first = copy.deepcopy(result_a[key])
        again = copy.deepcopy(result_a_again[key])
        first["planId"] = again["planId"]
        if key == "performancePlan":
            first["fingeringPlanId"] = again["fingeringPlanId"]
        if key == "motionPlan":
            first["performancePlanId"] = again["performancePlanId"]
        assert again == first


def test_replan_echoes_explicit_editor_intents_by_stable_id():
    fixture_id = "synthetic-scale-chords"
    source_bytes = (FIXTURES / "midi" / f"{fixture_id}.mid").read_bytes()
    analysis = _analysis(source_bytes, fixture_id)
    source_plan, options = _replan_options(analysis, "intent-replan-first")
    document = copy.deepcopy(analysis["document"])
    document["revision"] = 2
    source_plan["inputRevision"] = 2
    options["revision"] = 2

    by_note_id = {note["noteId"]: note for note in document["notes"]}
    assignments = {assignment["noteId"]: assignment for assignment in source_plan["assignments"]}
    eligible = [
        note for note in document["notes"]
        if not note["glissando"] and assignments[note["noteId"]]["disposition"] == "played"
    ]
    assert len(eligible) >= 3
    manual_id, automatic_id, gliss_intent_id = [note["noteId"] for note in eligible[:3]]

    by_note_id[manual_id]["finger"] = 4
    assignments[manual_id].update({
        "finger": 4, "disposition": "played", "fingerMode": "manual", "glissMode": "manual",
    })
    by_note_id[automatic_id]["finger"] = None
    assignments[automatic_id].update({
        "disposition": "played", "fingerMode": "automatic",
    })
    assignments[automatic_id].pop("glissMode", None)
    by_note_id[gliss_intent_id]["finger"] = None
    assignments[gliss_intent_id].update({
        "disposition": "played", "fingerMode": "automatic", "glissMode": "manual",
    })

    first = api.replan_document(source_bytes, document, source_plan, options)
    first_assignments = {item["noteId"]: item for item in first["fingeringPlan"]["assignments"]}
    assert first_assignments[manual_id]["finger"] == 4
    assert first_assignments[manual_id]["disposition"] == "played"
    assert first_assignments[manual_id]["fingerMode"] == "manual"
    assert first_assignments[manual_id]["glissMode"] == "manual"
    assert first_assignments[automatic_id]["fingerMode"] == "automatic"
    assert "glissMode" not in first_assignments[automatic_id]
    assert first_assignments[gliss_intent_id]["fingerMode"] == "automatic"
    assert first_assignments[gliss_intent_id]["glissMode"] == "manual"

    # A second user edit and engine response must retain those intent flags too,
    # so an editor history snapshot can rematerialize its older values later.
    second_document = copy.deepcopy(first["document"])
    second_document["revision"] = 3
    second_plan = copy.deepcopy(first["fingeringPlan"])
    second_plan["inputRevision"] = 3
    second_assignments = {item["noteId"]: item for item in second_plan["assignments"]}
    second_document_note = next(note for note in second_document["notes"] if note["noteId"] == manual_id)
    second_document_note["finger"] = 3
    second_assignments[manual_id].update({"finger": 3, "disposition": "played"})
    second_options = {**options, "revision": 3, "requestId": "intent-replan-second"}

    second = api.replan_document(source_bytes, second_document, second_plan, second_options)
    returned = {item["noteId"]: item for item in second["fingeringPlan"]["assignments"]}
    assert returned[manual_id]["finger"] == 3
    assert returned[manual_id]["disposition"] == "played"
    assert returned[manual_id]["fingerMode"] == "manual"
    assert returned[manual_id]["glissMode"] == "manual"
    assert returned[automatic_id]["fingerMode"] == "automatic"
    assert "glissMode" not in returned[automatic_id]
    assert returned[gliss_intent_id]["fingerMode"] == "automatic"
    assert returned[gliss_intent_id]["glissMode"] == "manual"


def test_typed_replan_rejects_identity_guessing_and_wrong_source_descriptor():
    fixture_id = "synthetic-duplicate-identities"
    source_bytes = (FIXTURES / "midi" / f"{fixture_id}.mid").read_bytes()
    analysis = _analysis(source_bytes, fixture_id)
    plan, options = _replan_options(analysis, "replan-invalid")

    changed_id_document = copy.deepcopy(analysis["document"])
    changed_id_document["notes"][0]["noteId"] = "guessed-by-ordinal"
    try:
        api.replan_document(source_bytes, changed_id_document, plan, options)
    except ValueError as error:
        assert "preserve every normalized note ID" in str(error)
    else:
        raise AssertionError("changed note identity must be rejected")

    wrong_source = copy.deepcopy(options)
    wrong_source["resource"]["sha256"] = hashlib.sha256(b"different MIDI").hexdigest()
    try:
        api.replan_document(source_bytes, analysis["document"], plan, wrong_source)
    except ValueError as error:
        assert "checksum" in str(error)
    else:
        raise AssertionError("wrong source checksum must be rejected")


if __name__ == "__main__":
    for test in (
        test_noop_typed_replan_preserves_full_source_document_and_baseline,
        test_profile_and_key_style_replan_is_deterministic_a_b_a,
        test_replan_echoes_explicit_editor_intents_by_stable_id,
        test_typed_replan_rejects_identity_guessing_and_wrong_source_descriptor,
    ):
        test()
        print(f"PASS: {test.__name__}")

