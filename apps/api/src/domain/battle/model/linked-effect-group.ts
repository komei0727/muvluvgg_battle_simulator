import type { BattleUnit } from "./battle-unit.js";
import type { EffectInstanceId, MarkerInstanceId } from "../../shared/event-ids.js";
import type {
  DurationDefinition,
  LinkedEffectGroupRole,
} from "../../catalog/definitions/duration-definition.js";

/** `LinkedGroupInstances`の片側だけをseedにする呼び出し向けの共有空集合。 */
export const NO_EFFECT_INSTANCE_IDS: ReadonlySet<EffectInstanceId> = new Set();
export const NO_MARKER_INSTANCE_IDS: ReadonlySet<MarkerInstanceId> = new Set();

/**
 * R-EFF-09の連動グループが同時に含み得る2種のインスタンス集合。`AppliedEffect`と
 * `MarkerState`は`EffectInstanceId`/`MarkerInstanceId`という別のID空間を持つため、
 * 単一の`Set`へ混ぜず種別ごとに分けて表す。
 */
export interface LinkedGroupInstances {
  readonly effectInstanceIds: ReadonlySet<EffectInstanceId>;
  readonly markerInstanceIds: ReadonlySet<MarkerInstanceId>;
}

/**
 * 連動グループの構成メンバー。`AppliedEffect`と`MarkerState`を同じBFSキューへ
 * 載せるための判別可能unionで、種別ごとのID空間を型のまま保つ。
 */
export type LinkedGroupMember =
  | { readonly kind: "EFFECT"; readonly effectInstanceId: EffectInstanceId }
  | { readonly kind: "MARKER"; readonly markerInstanceId: MarkerInstanceId };

/** BFSの訪問済み判定キー。`EffectInstanceId`と`MarkerInstanceId`の値衝突を防ぐため種別で接頭辞を付ける。 */
export type LinkedGroupMemberKey = string;

/** `LinkedGroupMember`を`Map`/`Set`のキーへ落とす（種別ごとのID空間を混ぜないため接頭辞を付ける）。 */
export function linkedGroupMemberKey(member: LinkedGroupMember): LinkedGroupMemberKey {
  return member.kind === "EFFECT" ? `E:${member.effectInstanceId}` : `M:${member.markerInstanceId}`;
}

/**
 * R-EFF-09「linkedEffectGroup」: 同じ`linkedEffectGroupId`を持つ`AppliedEffect`と
 * `MarkerState`は**ひとつの**親子連動グループとして扱う（第1項）。
 * `seeds`（既に失効・解除が確定したインスタンス）から、同じグループへ属する
 * 未失効インスタンスを種別を問わずすべて収集する（BFS）。グループは
 * `linkedEffectGroupId`という値だけで識別され、どのユニットの`appliedEffects`／
 * `markerStates`に保持されているかは問わない — グループは特定ユニットへ閉じない
 * （`14_Catalog定義スキーマ.md`のスキーマ自体にユニット単位の制約がない）。
 * 呼び出し側（`linked-group-cascade.ts`経由の`duration-expiry-service.ts`／
 * `marker-removal-service.ts`／`effect-removal-service.ts`／
 * `freeze-removal-service.ts`）が、この結果集合から「子を先に、親を最後に」
 * 失効イベントを順序付けて発行する。
 *
 * レビュー再指摘[P2]（PR #209）: `linkedEffectGroupRole`（`PARENT`/`CHILD`）を
 * 明示するメンバーがいるグループでは、カスケードの起点を`CHILD`ロールの
 * seedからは起こさない（R-EFF-09「子効果だけが消費条件で失効した場合、親効果は
 * 維持する」— 失効理由ではなく明示的な親子関係で判定する）。`PARENT`ロールの
 * seed（または`linkedEffectGroupId`のみでロールを持たないレガシーな
 * seed）は、理由を問わず同グループ全体へカスケードする。一度カスケードが
 * 到達したグループ内では、そこから先の（`CHILD`経由の）伝播はグループが
 * 既に完全に閉じているため実質no-opであり、追加のロール判定は不要。
 *
 * M7-013（Issue #267）: EFF-003（`applied-effect-linked-group.ts`、
 * `AppliedEffect`同士）とEFF-004（`marker-linked-group.ts`、`MarkerState`同士）が
 * 種別ごとに分かれて持っていた同一アルゴリズムを、R-EFF-09第1項が規定する
 * cross-typeカスケードのためにこの1関数へ統合した。
 */
export function collectLinkedGroupCascade(
  units: readonly BattleUnit[],
  seeds: LinkedGroupInstances,
): LinkedGroupInstances {
  const groupIdByKey = new Map<LinkedGroupMemberKey, string>();
  const roleByKey = new Map<LinkedGroupMemberKey, LinkedEffectGroupRole | undefined>();
  const membersByGroupId = new Map<string, LinkedGroupMember[]>();

  const register = (member: LinkedGroupMember, definition: DurationDefinition): void => {
    const groupId = definition.linkedEffectGroupId;
    if (groupId === null) {
      return;
    }
    groupIdByKey.set(linkedGroupMemberKey(member), groupId);
    roleByKey.set(linkedGroupMemberKey(member), definition.linkedEffectGroupRole);
    const bucket = membersByGroupId.get(groupId);
    if (bucket === undefined) {
      membersByGroupId.set(groupId, [member]);
    } else {
      bucket.push(member);
    }
  };

  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      register(
        { kind: "EFFECT", effectInstanceId: effect.effectInstanceId },
        effect.duration.definition,
      );
    }
    for (const marker of unit.markerStates) {
      register(
        { kind: "MARKER", markerInstanceId: marker.markerInstanceId },
        marker.duration.definition,
      );
    }
  }

  const effectInstanceIds = new Set(seeds.effectInstanceIds);
  const markerInstanceIds = new Set(seeds.markerInstanceIds);
  const seedMembers: LinkedGroupMember[] = [
    ...[...seeds.effectInstanceIds].map(
      (effectInstanceId): LinkedGroupMember => ({ kind: "EFFECT", effectInstanceId }),
    ),
    ...[...seeds.markerInstanceIds].map(
      (markerInstanceId): LinkedGroupMember => ({ kind: "MARKER", markerInstanceId }),
    ),
  ];
  const visited = new Set<LinkedGroupMemberKey>(seedMembers.map(linkedGroupMemberKey));
  const queue = seedMembers.filter(
    (member) => roleByKey.get(linkedGroupMemberKey(member)) !== "CHILD",
  );

  while (queue.length > 0) {
    const member = queue.shift()!;
    const groupId = groupIdByKey.get(linkedGroupMemberKey(member));
    if (groupId === undefined) {
      continue;
    }
    for (const sibling of membersByGroupId.get(groupId) ?? []) {
      const key = linkedGroupMemberKey(sibling);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      queue.push(sibling);
      if (sibling.kind === "EFFECT") {
        effectInstanceIds.add(sibling.effectInstanceId);
      } else {
        markerInstanceIds.add(sibling.markerInstanceId);
      }
    }
  }

  return { effectInstanceIds, markerInstanceIds };
}
