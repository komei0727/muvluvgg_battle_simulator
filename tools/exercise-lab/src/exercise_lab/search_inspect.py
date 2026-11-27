"""保存した試行の再生と、スコア差を調べるためのイベント要約。"""

from __future__ import annotations

import json
import tempfile
from collections import Counter
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from mlgg_lab_common.api.client import classify_exchange
from mlgg_lab_common.experiments.search_store import SqliteSearchStore
from mlgg_lab_common.models import ConfigError

from .search_reports import SavedTrial, trial_results
from .search_round import Phase, phase_seed

SIMULATION_PATH = "/api/v1/tactical-exercises"
SUMMARY_FIELDS = ("totalScore", "breakCount", "completionReason", "completedTurn")


def _replay(
    store: SqliteSearchStore, trial: SavedTrial, access_key: str | None
) -> tuple[dict, Path]:
    body = trial.match_request | {
        "replay": {
            "seed": trial.seed,
            "runIndex": trial.result.run_index,
            "expectedCatalogRevision": trial.environment.catalog_revision,
            "expectedEngineRevision": trial.environment.engine_revision,
            "expectedSeedDerivationVersion": trial.environment.seed_derivation_version,
        },
    }
    with trial.settings.http_client(access_key=access_key) as client:
        exchange = client.post_json(SIMULATION_PATH, body)
    failure = classify_exchange(exchange)
    if failure is not None:
        raise ConfigError(f"詳細再生: {failure.kind.value} {failure.message}")
    try:
        response = json.loads(exchange.body or "")
        result = response["result"]
        mismatches = [
            name for name in SUMMARY_FIELDS if result[name] != trial.result.observation[name]
        ]
        if response["catalogRevision"] != trial.environment.catalog_revision:
            mismatches.append("catalogRevision")
        if mismatches:
            raise ConfigError(f"保存済み試行と再生結果が一致しない: {', '.join(mismatches)}")
        if not response["events"] or not isinstance(response["events"], list):
            raise ConfigError("再生APIの応答に詳細イベントが無い")
        # 詳細ログの必須部分も確認してから、検証済みの再生として保存する。
        for field in ("initialState", "stateTransitions"):
            response[field]
    except (ValueError, KeyError, TypeError) as error:
        raise ConfigError(f"再生APIの応答を読めない: {error}") from error

    directory = store.directory / "traces"
    directory.mkdir(exist_ok=True)
    case = trial.result.case_id
    path = directory / f"{trial.evaluation_id}-{case}-{trial.result.run_index}.json"
    with tempfile.NamedTemporaryFile(
        dir=directory, delete=False, mode="w", encoding="utf-8"
    ) as out:
        temporary = Path(out.name)
        try:
            out.write(exchange.body or "")
            out.write("\n")
            out.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return response, path.resolve()


def _summarize(response: dict, units: set[str], effects: set[str], limit: int) -> dict:
    roster = {
        unit["battleUnitId"]: unit["unitDefinitionId"] for unit in response["initialState"]["units"]
    }
    attacks = {
        unit["battleUnitId"]: unit["combatStats"]["attack"]
        for unit in response["initialState"]["units"]
    }
    events = response["events"]
    by_sequence = {event["sequence"]: event for event in events}
    actions = {
        event.get("actionId"): event["details"]["actorUnitId"]
        for event in events
        if event["type"] == "ACTION_STARTED" and "actionId" in event
    }
    skills = {
        event["skillUseId"]: event["details"]["skillDefinitionId"]
        for event in events
        if "skillUseId" in event
        and (event["type"] in {"SKILL_USE_STARTING", "SKILL_USE_STARTED", "SKILL_USE_COMPLETED"})
    }

    def unit_id(battle_unit: str | None) -> str | None:
        return roster.get(battle_unit, battle_unit)

    def ancestors(event: dict) -> Iterator[dict]:
        ceiling = event["sequence"]
        sequence = event.get("parentSequence")
        while sequence in by_sequence and sequence < ceiling:
            parent = by_sequence[sequence]
            yield parent
            ceiling = sequence
            sequence = parent.get("parentSequence")

    def actor(event: dict) -> str | None:
        # 多段攻撃や割込みでは行動枠のユニットと実際の発生源が異なる。
        for parent in ancestors(event):
            source = parent.get("sourceUnitId") or parent["details"].get("actorUnitId")
            if source is not None and any(
                name in parent["type"] for name in ("HIT", "DAMAGE", "SKILL_USE", "ATTACK")
            ):
                return unit_id(source)
        return unit_id(actions.get(event.get("actionId")))

    def relevant(*ids: str | None) -> bool:
        return not units or bool(units.intersection(ids))

    score_by_turn: Counter = Counter()
    score_by_skill: Counter = Counter()
    critical_checks: Counter = Counter()
    critical_hits: Counter = Counter()
    memory_triggers: Counter = Counter()
    effect_instances: dict[str, dict] = {}
    queues, actions_taken, target_rows, effect_rows = [], [], [], []
    score = 0
    for event in events:
        kind, details = event["type"], event["details"]
        record = {"turn": event["turnNumber"], "sequence": event["sequence"]}
        source = unit_id(event.get("sourceUnitId") or details.get("sourceUnitId"))
        if kind == "ACTION_QUEUE_CREATED":
            queues.append(
                record
                | {
                    "cycle": details["cycleNumber"],
                    "reservations": [
                        {"unitId": unit_id(row["battleUnitId"]), "actionSpeed": row["actionSpeed"]}
                        for row in details["reservations"]
                    ],
                }
            )
        elif kind == "ACTION_STARTED":
            actions_taken.append(
                record
                | {
                    "unitId": unit_id(details["actorUnitId"]),
                    "actionType": details["effectiveActionType"],
                }
            )
        elif kind == "TARGETS_SELECTED":
            bindings = [
                {
                    "bindingId": binding["targetBindingId"],
                    "targetUnitIds": [unit_id(uid) for uid in binding["selectedTargetUnitIds"]],
                }
                for binding in details["bindings"]
            ]
            source = source or unit_id(actions.get(event.get("actionId")))
            if relevant(source, *(target for row in bindings for target in row["targetUnitIds"])):
                target_rows.append(
                    record
                    | {
                        "skillId": details["skillDefinitionId"],
                        "actorUnitId": source,
                        "bindings": bindings,
                        "allyAttackAtSelection": [
                            {"unitId": unit_id(uid), "battleUnitId": uid, "attack": value}
                            for uid, value in attacks.items()
                            if uid.startswith("ally:")
                        ],
                    }
                )
        elif kind == "EFFECT_APPLIED":
            effect = details["effectActionDefinitionId"]
            target = unit_id(details["targetUnitId"])
            entry = record | {
                "effectId": effect,
                "instanceId": details["effectInstanceId"],
                "sourceUnitId": source,
                "targetUnitId": target,
                "event": kind,
                "magnitude": details["magnitude"],
                "consumptionKind": details.get("consumptionKind"),
            }
            effect_instances[details["effectInstanceId"]] = entry
            if (not effects or effect in effects) and relevant(source, target):
                effect_rows.append(entry)
        elif kind == "EFFECT_CONSUMPTION_CHANGED":
            applied = effect_instances.get(details["effectInstanceId"], {})
            effect = applied.get("effectId")
            consumer = actor(event)
            if (not effects or effect in effects) and relevant(
                consumer, applied.get("sourceUnitId"), applied.get("targetUnitId")
            ):
                effect_rows.append(
                    record
                    | {
                        "effectId": effect,
                        "instanceId": details["effectInstanceId"],
                        "event": kind,
                        "appliedSequence": applied.get("sequence"),
                        "consumerUnitId": consumer,
                        "parentSequence": event.get("parentSequence"),
                        "remaining": details["after"],
                    }
                )
        elif kind in {"EFFECT_REMOVED", "EFFECT_EXPIRED"}:
            instance = details["effectInstanceId"]
            applied = effect_instances.get(instance, {})
            effect = applied.get("effectId")
            if (not effects or effect in effects) and relevant(
                applied.get("sourceUnitId"), applied.get("targetUnitId")
            ):
                effect_rows.append(
                    record
                    | {
                        "effectId": effect,
                        "instanceId": instance,
                        "event": kind,
                        "appliedSequence": applied.get("sequence"),
                        "reason": details.get("reason"),
                    }
                )
        elif kind == "CRITICAL_CHECK_RESOLVED" and source is not None and relevant(source):
            critical_checks[source] += 1
            critical_hits[source] += bool(details["result"])
        elif kind == "MEMORY_TRIGGERED":
            memory_triggers[details["memoryDefinitionId"]] += 1
        elif kind in {"EXERCISE_SCORE_ACCUMULATED", "EXERCISE_SCORE_DEDUCTED"}:
            latest = details["totalScore"]
            delta = latest - score
            score = latest
            score_by_turn[str(event["turnNumber"])] += delta
            memory = next(
                (
                    parent["details"]["memoryDefinitionId"]
                    for parent in ancestors(event)
                    if parent["type"] == "MEMORY_TRIGGERED"
                ),
                None,
            )
            origin = memory or skills.get(event.get("skillUseId")) or actor(event) or source or kind
            score_by_skill[origin] += delta

        transition = event.get("stateTransitionIndex")
        if transition is not None:
            changes = response["stateTransitions"][transition]["delta"].get("units", {})
            for uid, change in changes.items():
                attack = change.get("combatStats", {}).get("attack")
                if attack is not None:
                    attacks[uid] = attack["after"]

    return {
        "result": response["result"],
        "eventCount": len(events),
        "scoreByTurn": dict(score_by_turn),
        "scoreBySkill": dict(score_by_skill),
        "critical": {
            uid: {"checks": count, "hits": critical_hits[uid]}
            for uid, count in critical_checks.items()
        },
        "memoryTriggers": dict(memory_triggers),
        "actionQueues": queues,
        "actionsTaken": actions_taken,
        "targetSelections": {"count": len(target_rows), "events": target_rows[:limit]},
        "effectEvents": {"count": len(effect_rows), "events": effect_rows[:limit]},
    }


def inspect_trials(
    store: SqliteSearchStore,
    candidate: str,
    indices: Sequence[int],
    phase: Phase,
    baseline: str | None,
    evaluation_id: str | None,
    units: Sequence[str],
    effects: Sequence[str],
    limit: int,
    access_key: str | None,
) -> dict:
    seed = phase_seed(store.load_problem(), phase)
    ids = {candidate} if baseline is None else {candidate, baseline}
    found = {
        (trial.candidate_id, trial.result.run_index): trial
        for trial in trial_results(store, seed=seed, candidate_ids=ids, run_indices=set(indices))
        if (
            trial.candidate_id != candidate
            or evaluation_id is None
            or trial.evaluation_id == evaluation_id
        )
    }
    for cid in ids:
        for index in indices:
            if (cid, index) not in found:
                raise ConfigError(f"完了した試行が見つからない: {cid} / {phase} / {index}")
    entries = []
    for index in dict.fromkeys(indices):
        replays = {}
        for cid in dict.fromkeys([candidate, baseline] if baseline is not None else [candidate]):
            trial = found[cid, index]
            body, path = _replay(store, trial, access_key)
            try:
                trace = _summarize(body, set(units), set(effects), limit)
            except (IndexError, KeyError, TypeError) as error:
                raise ConfigError(f"再生APIの詳細ログを読めない: {error}") from error
            replays[cid] = {"trial": trial.reference(), "tracePath": str(path), **trace}
        item: dict[str, Any] = {"candidate": replays[candidate]}
        if baseline is not None:
            a, b = replays[baseline], replays[candidate]
            item["baseline"] = a
            item["delta"] = {
                field: b["result"][field] - a["result"][field]
                for field in ("totalScore", "breakCount")
            }
            for field in ("scoreByTurn", "scoreBySkill"):
                item["delta"][field] = {
                    key: b[field].get(key, 0) - a[field].get(key, 0)
                    for key in sorted(a[field].keys() | b[field].keys())
                }
        entries.append(item)
    return {"seed": seed, "phase": phase, "trials": entries}
