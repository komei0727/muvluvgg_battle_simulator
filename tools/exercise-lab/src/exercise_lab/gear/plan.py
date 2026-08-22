"""Phase C: レジーム再スタートと、A→B→C の取りまとめ。

山登り（`search.py`）は「攻撃を下げると一度スコアが落ちてから上がる」谷を越えられない。
順位で当て先が決まる効果は、順位がひっくり返るまで何も起きず、ひっくり返った瞬間に
まとめて動くためである。**ここが理論値探索の本体**である。

やることは1つ——署名の成分を1つ選び、その受け先が変わるまでギアを積む／減らす。変わったら
そこから Phase B を再開する。谷の底を通り抜けるためだけの手なので、途中のスコアは見ない。

**レジームは事前に列挙できない**ので、どの成分をどちらへ押すかは観測から決める。Phase B が
「自ユニット与ダメが伸びていないのに総スコアが伸びた」手を報告するので、その枠が受け先に
なっている成分を優先する。押す向きは両方試す——`HIGHEST_ATTACK` なら受け先の攻撃力を
下げると外れ、`LOWEST_ATTACK` なら上げると外れる。どちらの順位キーかはAPIからは分からない。

到達した署名は origin つきで残す。**探索が触れなかった署名は列挙できない**（列挙できる
なら探索は要らない）が、「押したのに署名が変わらなかった向き」は残せる——そこは触れて
いない、と読めるようにする。

配分が収束したら Phase D（`rank_tuning.py`）へ渡す。ここまでは枚数だけを動かしており、
ランクは近傍に入れていない（1枚あたり9通りの替えで近傍が2桁増えるため）。**枚数では
刻めない閾値**を、境界に関わる枠に限ってランクで刻むのが最後の段である。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from ..optimize.fitness import Objective
from .allocation import (
    MAX_PIECES_PER_STAT,
    MAX_PIECES_PER_UNIT,
    SEARCHED_STATS,
    Allocation,
    GearPiece,
    UnitAllocation,
)
from .neighborhood import Move
from .rank_tuning import (
    RankTuningResult,
    RankTuningSettings,
    focus_targets,
    max_target_count,
    rank_round_cost,
    tune_ranks,
)
from .rank_tuning import (
    observation_count as rank_observation_count,
)
from .ranks import EMPTY_LADDER, RankLadder
from .regime import RegimeSignature, SignatureObserver, slot_index_of
from .search import (
    BudgetedSampleSource,
    ClimbResult,
    ClimbSettings,
    hill_climb,
    iteration_cost,
    phases_for_climb,
)

UP = "UP"
DOWN = "DOWN"
DIRECTIONS = (UP, DOWN)

SIGNATURE_CHANGED = "SIGNATURE_CHANGED"
NO_CHANGE = "NO_CHANGE"
NO_MOVE = "NO_MOVE"

# 押す対象のステータス。順位セレクタの当て先は攻撃力で決まるものが大半で、
# ギアで動かせるのもここである（`14_Catalog定義スキーマ.md`「HIGHEST_ATTACK」）。
PUSH_STAT = "ATTACK"


@dataclass(frozen=True)
class PlanSettings:
    climb: ClimbSettings = field(default_factory=ClimbSettings)
    # 再スタート本数。1本 = (成分, 向き) の組1つ。
    restarts: int = 4
    # 1本で押す最大手数。これを超えても署名が変わらなければ、その向きは諦める。
    push_steps: int = 4
    # Phase D。収束した配分のランクを、境界に関わる枠だけ下げて刻む。
    rank: RankTuningSettings = field(default_factory=RankTuningSettings)


@dataclass(frozen=True)
class ObservedSignature:
    """観測した署名1件と、どこで観測したか。"""

    origin: str
    allocation: Allocation
    signature: RegimeSignature


@dataclass(frozen=True)
class RestartAttempt:
    """再スタート1本。署名が変わるまで押し、変わったらそこから登り直す。"""

    index: int
    component: str
    direction: str
    slot_index: int
    moves: tuple[Move, ...] = ()
    pushed: tuple[Allocation, ...] = ()
    changed: bool = False
    signature: RegimeSignature | None = None
    climb: ClimbResult | None = None
    stopped_because: str = NO_CHANGE


@dataclass(frozen=True)
class PlanResult:
    start: Allocation
    best: Allocation
    base_signature: RegimeSignature
    base_climb: ClimbResult
    restarts: tuple[RestartAttempt, ...] = ()
    # Phase D を回さなかった実行（効果表が無い・`--rank-steps 0`）では `None`。
    rank_tuning: RankTuningResult | None = None
    signatures: tuple[ObservedSignature, ...] = ()
    ranking: tuple[tuple[Allocation, float], ...] = ()
    consumed_runs: int = 0
    warnings: tuple[str, ...] = ()


def plan_budget(settings: PlanSettings, *, move_count: int, unit_count: int = 0) -> dict[str, int]:
    """試行数の内訳。上限であって実測ではない（改善が止まれば途中で終わる）。

    Phase D の額は**全枠がどちらの境界にも関わった場合**（`max_target_count`）で
    見積もる。実際の対象は署名を観測してから決まるので事前には分からず、少なく
    見積もると内訳・所要時間・進捗バーの総数が過小になる。
    """
    per_iteration = iteration_cost(settings.climb, move_count=move_count)
    per_climb = per_iteration * settings.climb.max_iterations
    rank = rank_round_cost(settings.rank, settings.climb, target_count=max_target_count(unit_count))
    return {
        "perIteration": per_iteration,
        "perClimb": per_climb,
        "climbs": 1 + settings.restarts,
        "rankTuning": rank,
        "total": per_climb * (1 + settings.restarts) + rank,
    }


def minimum_budget(settings: PlanSettings, *, move_count: int) -> int:
    """1反復を回しきるのに要る最低試行数。**校正のぶんを別に足さない。**

    校正は基点を篩いの深さで測るだけで、その結果は反復1の篩いがキャッシュから読む。
    したがって校正込みの実消費はちょうど1反復ぶんであり、上乗せすると
    `iteration_cost <= --budget < iteration_cost + screen_runs` の予算を「1反復も
    回せない」と誤って拒むことになる。

    予算がこれに満たなければ、校正も含めて1試行も投げずに終える。`--budget` を
    「これを超えて評価を発行しない」上限として示している以上、校正だけが例外に
    なってはいけない。
    """
    return iteration_cost(settings.climb, move_count=move_count)


def observation_count(settings: PlanSettings, *, unit_count: int = 0) -> int:
    """単発実行の回数。基点・基点の解・各再スタートの押し1手ごとと登った先・Phase D。

    一括評価の試行数とは別勘定にする。1リクエスト1試行で `DETAILED` のイベント列を
    返すため、所要時間の性質が違う。
    """
    return (
        1
        + 1
        + settings.restarts * (settings.push_steps + 1)
        + rank_observation_count(settings.rank, target_count=max_target_count(unit_count))
    )


def plan_gear_allocation(
    start: Allocation,
    evaluator: BudgetedSampleSource[Allocation],
    observer: SignatureObserver,
    *,
    settings: PlanSettings,
    objective: Objective,
    budget_runs: int,
    ladder: RankLadder = EMPTY_LADDER,
) -> PlanResult:
    """Phase A（観測）→ B（山登り）→ C（レジーム再スタート）→ D（ランク微調整）を通す。"""
    base_signature = observer.observe(start)
    observations = [ObservedSignature(origin="base", allocation=start, signature=base_signature)]

    base_climb = hill_climb(
        start,
        evaluator,
        settings=settings.climb,
        objective=objective,
        budget_runs=budget_runs,
    )
    solved_signature = observer.observe(base_climb.best)
    observations.append(
        ObservedSignature(
            origin="base-climb", allocation=base_climb.best, signature=solved_signature
        )
    )

    attempts: list[RestartAttempt] = []
    winners = [base_climb.best]
    for index, (component, direction) in enumerate(
        _restart_directions(solved_signature, base_climb, settings), start=1
    ):
        attempt = _restart(
            index,
            component,
            direction,
            base_climb.best,
            solved_signature,
            evaluator,
            observer,
            observations,
            settings=settings,
            objective=objective,
            budget_runs=budget_runs,
        )
        attempts.append(attempt)
        if attempt.climb is not None:
            winners.append(attempt.climb.best)

    ranking = _rank(winners, evaluator, settings=settings, objective=objective)
    best = ranking[0][0] if ranking else base_climb.best
    warnings = list(base_climb.warnings)
    for attempt in attempts:
        if attempt.climb is not None:
            warnings.extend(attempt.climb.warnings)

    tuning = _tune_ranks(
        best,
        evaluator,
        observer,
        observations,
        ladder=ladder,
        settings=settings,
        objective=objective,
        budget_runs=budget_runs,
    )
    if tuning is not None:
        warnings.extend(tuning.warnings)
        winners.extend(entry.allocation for entry in tuning.signatures)
        ranking = _rank(winners, evaluator, settings=settings, objective=objective)
        best = ranking[0][0] if ranking else best

    return PlanResult(
        start=start,
        best=best,
        base_signature=base_signature,
        base_climb=base_climb,
        restarts=tuple(attempts),
        rank_tuning=tuning,
        signatures=tuple(observations),
        ranking=tuple(ranking),
        consumed_runs=evaluator.consumed_runs,
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _tune_ranks(
    best: Allocation,
    evaluator: BudgetedSampleSource[Allocation],
    observer: SignatureObserver,
    observations: list[ObservedSignature],
    *,
    ladder: RankLadder,
    settings: PlanSettings,
    objective: Objective,
    budget_runs: int,
) -> RankTuningResult | None:
    """Phase D。**ここまでに観測した署名すべて**から境界を決めて渡す。

    基点・各再スタート・登った先を通して当て先が動いた成分だけが境界の証拠であり、
    どれか1回の観測だけでは「動いた」を判定できない。
    """
    if ladder.is_empty() or settings.rank.steps < 1:
        return None
    result = tune_ranks(
        best,
        evaluator,
        observer,
        ladder=ladder,
        targets=focus_targets([entry.signature for entry in observations]),
        settings=settings.rank,
        climb=settings.climb,
        objective=objective,
        budget_runs=budget_runs,
    )
    observations.extend(
        ObservedSignature(
            origin=f"rank{index}-step{stop.step}",
            allocation=stop.allocation,
            signature=stop.signature,
        )
        for index, walk in enumerate(result.walks, start=1)
        for stop in walk.stops
    )
    return result


def _restart_directions(
    signature: RegimeSignature, climb: ClimbResult, settings: PlanSettings
) -> list[tuple[str, str]]:
    """試す (成分, 向き) の並び。Phase B が疑った枠を先に置く。

    「自ユニット与ダメが伸びていないのに総スコアが伸びた」手の枠が受け先になっている
    成分は、順位で当て先が決まる効果である疑いが濃い。そこから試す。
    """
    suspected = {candidate.move.slot_index for candidate in climb.regime_candidates}
    components = [
        component
        for component, recipient in sorted(signature.assignments.items())
        # 押せるのは味方枠だけである。敵が受け先の効果はギアでは動かせない。
        if slot_index_of(recipient) is not None
    ]
    components.sort(
        key=lambda name: (slot_index_of(signature.assignments[name]) not in suspected, name)
    )
    pairs = [(component, direction) for component in components for direction in DIRECTIONS]
    return pairs[: settings.restarts]


def _restart(
    index: int,
    component: str,
    direction: str,
    origin: Allocation,
    origin_signature: RegimeSignature,
    evaluator: BudgetedSampleSource[Allocation],
    observer: SignatureObserver,
    observations: list[ObservedSignature],
    *,
    settings: PlanSettings,
    objective: Objective,
    budget_runs: int,
) -> RestartAttempt:
    slot_index = slot_index_of(origin_signature.assignments[component])
    assert slot_index is not None
    allocation = origin
    moves: list[Move] = []
    pushed: list[Allocation] = []
    for step in range(1, settings.push_steps + 1):
        move = _push_move(allocation, slot_index, direction, settings)
        if move is None:
            return RestartAttempt(
                index=index,
                component=component,
                direction=direction,
                slot_index=slot_index,
                moves=tuple(moves),
                pushed=tuple(pushed),
                stopped_because=NO_MOVE,
            )
        applied = move.apply(allocation)
        if applied is None:
            return RestartAttempt(
                index=index,
                component=component,
                direction=direction,
                slot_index=slot_index,
                moves=tuple(moves),
                pushed=tuple(pushed),
                stopped_because=NO_MOVE,
            )
        allocation = applied
        moves.append(move)
        pushed.append(allocation)
        signature = observer.observe(allocation)
        observations.append(
            ObservedSignature(
                origin=f"restart{index}-push{step}", allocation=allocation, signature=signature
            )
        )
        if signature.recipient(component) == origin_signature.recipient(component):
            continue
        # 署名が変わった。谷の向こう側に居るので、ここから登り直す。
        climb = hill_climb(
            allocation,
            evaluator,
            settings=settings.climb,
            objective=objective,
            budget_runs=budget_runs,
        )
        observations.append(
            ObservedSignature(
                origin=f"restart{index}-climb",
                allocation=climb.best,
                signature=observer.observe(climb.best),
            )
        )
        return RestartAttempt(
            index=index,
            component=component,
            direction=direction,
            slot_index=slot_index,
            moves=tuple(moves),
            pushed=tuple(pushed),
            changed=True,
            signature=signature,
            climb=climb,
            stopped_because=SIGNATURE_CHANGED,
        )
    return RestartAttempt(
        index=index,
        component=component,
        direction=direction,
        slot_index=slot_index,
        moves=tuple(moves),
        pushed=tuple(pushed),
        stopped_because=NO_CHANGE,
    )


def _push_move(
    allocation: Allocation, slot_index: int, direction: str, settings: PlanSettings
) -> Move | None:
    """順位を動かすための1手。スコアは見ない——谷を通り抜けるためだけの手である。"""
    unit = allocation.units[slot_index]
    if direction == UP:
        return _push_up(unit, slot_index, settings)
    return _push_down(unit, slot_index)


def _push_up(unit: UnitAllocation, slot_index: int, settings: PlanSettings) -> Move | None:
    """攻撃力を1枚増やす。空枠があれば足し、無ければ他のステータスから移す。

    足す方を先に試すのは、移すと別のステータスを1枚失うためである（谷を深くする）。
    足す1枚のランクは近傍と同じ（`--add-rank`）にする——押しだけ上等なギアを仮定すると、
    到達した配分が「手に入れられないギアを含む答え」になる。
    """
    if unit.count(PUSH_STAT) >= MAX_PIECES_PER_STAT:
        return None
    rank = settings.climb.add_rank
    if unit.total < MAX_PIECES_PER_UNIT:
        return Move(
            kind="add",
            slot_index=slot_index,
            unit_definition_id=unit.unit_definition_id,
            removed=None,
            added=rank.with_stat(PUSH_STAT),
        )
    donor = _donor_piece(unit)
    if donor is None:
        return None
    return Move(
        kind="move",
        slot_index=slot_index,
        unit_definition_id=unit.unit_definition_id,
        removed=donor,
        added=donor.rank.with_stat(PUSH_STAT),
    )


def _push_down(unit: UnitAllocation, slot_index: int) -> Move | None:
    """攻撃力を1枚減らす。枠は失わずに済む移し先があればそちらへ移す。"""
    attack = next((piece for piece in unit.pieces if piece.stat == PUSH_STAT), None)
    if attack is None:
        return None
    target = _receiver_stat(unit)
    if target is None:
        return Move(
            kind="remove",
            slot_index=slot_index,
            unit_definition_id=unit.unit_definition_id,
            removed=attack,
            added=None,
        )
    return Move(
        kind="move",
        slot_index=slot_index,
        unit_definition_id=unit.unit_definition_id,
        removed=attack,
        added=attack.rank.with_stat(target),
    )


def _donor_piece(unit: UnitAllocation) -> GearPiece | None:
    """攻撃力へ移す1枚。枚数の多いステータスから出す（構成の偏りを崩さない）。"""
    candidates = [piece for piece in unit.distinct_pieces() if piece.stat != PUSH_STAT]
    if not candidates:
        return None
    return max(candidates, key=lambda piece: (unit.count(piece.stat), -piece.sort_key()[0]))


def _receiver_stat(unit: UnitAllocation) -> str | None:
    """攻撃力から移す先。上限に達していない中で最も枚数の少ないステータス。"""
    room = [
        stat
        for stat in SEARCHED_STATS
        if stat != PUSH_STAT and unit.count(stat) < MAX_PIECES_PER_STAT
    ]
    if not room:
        return None
    return min(room, key=lambda stat: (unit.count(stat), SEARCHED_STATS.index(stat)))


def _rank(
    winners: Sequence[Allocation],
    evaluator: BudgetedSampleSource[Allocation],
    *,
    settings: PlanSettings,
    objective: Objective,
) -> list[tuple[Allocation, float]]:
    """各枝の到達点を同じ試行数で並べる。**新しい評価は1件も発行しない。**

    どの到達点も確定段で評価済み（自分の枝で候補として深く測られている）なので、履歴を
    読むだけで並べられる。ここで `ensure` を呼ぶと、予算を使い切って登れなかった枝の
    ぶんまで追加の試行を投げることになり、予算が上限である約束を破る。

    **これは最終選抜ではない** —— 探索が使ったのと同じ乱数範囲で並べているため、その
    範囲へ過適合した枝が上に来うる。別の乱数範囲での確定は最終選抜（別Issue）が行う。
    """
    unique: list[Allocation] = []
    seen: set[str] = set()
    for allocation in winners:
        key = allocation.canonical_key()
        if key not in seen:
            seen.add(key)
            unique.append(allocation)
    _, confirm_phase = phases_for_climb(settings.climb)
    records = [
        record
        for allocation in unique
        if (record := evaluator.record_for(allocation, confirm_phase)) is not None
    ]
    counts = [record.sample_count for record in records if record.sample_count > 0]
    if not counts:
        return []
    count = min(counts)
    ranked = [
        (record.candidate, objective.fitness(record.scores_at(count)))
        for record in records
        if record.sample_count >= count
    ]
    ranked.sort(key=lambda pair: pair[1], reverse=True)
    return ranked
