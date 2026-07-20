/**
 * R-EFF-09: 同じ`linkedEffectGroupId`を持つ`AppliedEffect`/`MarkerState`は
 * 親子連動グループとして扱う。Catalogスキーマは親子の区別を持つ専用フィールド
 * を持たないため、R-STA-03「最初に付与されたものを代表として扱う」と同じ
 * 規則を援用し、グループ内で最初に付与された（`groupMembersInGrantOrder`の
 * 先頭）メンバーを親とみなす。
 */
export interface LinkedGroupMember {
  /** 呼び出し側が`EffectInstanceId`/`MarkerId`を渡す不透明なキー。 */
  readonly key: string;
  readonly linkedEffectGroupId: string | null;
}

/** `member`がそのグループの親（グループ内で最初に付与されたメンバー）かどうか。グループを持たない場合は常にfalse。 */
export function isLinkedGroupParent(
  member: LinkedGroupMember,
  groupMembersInGrantOrder: readonly LinkedGroupMember[],
): boolean {
  if (member.linkedEffectGroupId === null) {
    return false;
  }
  const first = groupMembersInGrantOrder.find(
    (m) => m.linkedEffectGroupId === member.linkedEffectGroupId,
  );
  return first?.key === member.key;
}

/** `parent`と同じ`linkedEffectGroupId`を持つ、`parent`自身以外の全メンバー。 */
export function linkedGroupChildren(
  parent: LinkedGroupMember,
  groupMembersInGrantOrder: readonly LinkedGroupMember[],
): readonly LinkedGroupMember[] {
  return groupMembersInGrantOrder.filter(
    (m) => m.linkedEffectGroupId === parent.linkedEffectGroupId && m.key !== parent.key,
  );
}
