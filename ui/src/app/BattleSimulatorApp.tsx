import type { ApiBaseUrlResult } from "../lib/env.js";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";

export interface BattleSimulatorAppProps {
  readonly apiBaseUrlResult: ApiBaseUrlResult;
}

const CONFIG_ERROR_MESSAGE =
  "API接続先の設定が不正なため、アプリケーションを起動できません。運用担当者へ連絡してください。";

// The formation editor, Catalog client, and simulation execution flow are
// delivered by later M4.5 UI issues (#94-#97). This shell only proves the
// workspace, design tokens, and primitives compose and build correctly.
export function BattleSimulatorApp({ apiBaseUrlResult }: BattleSimulatorAppProps) {
  if (!apiBaseUrlResult.ok) {
    return <p role="alert">{CONFIG_ERROR_MESSAGE}</p>;
  }

  return (
    <AppShell>
      <Panel step="01" title="戦闘パラメータ" meta="FORMATION / MEMORY / EXECUTION">
        <p>編成Editorと戦闘実行は今後のIssueで追加されます。</p>
      </Panel>
    </AppShell>
  );
}
