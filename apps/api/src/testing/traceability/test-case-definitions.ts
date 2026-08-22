import { readdirSync, readFileSync } from "node:fs";
import * as ts from "typescript";

/**
 * テストケースIDが「リポジトリ内に実在する実行対象テスト」であることを、
 * TypeScript Compiler APIでソースを解析して機械的に判定するためのユーティリティ。
 *
 * トレーサビリティ台帳（{@link ../rule-coverage.ts}）と残作業対応表
 * （{@link ./remaining-work.test.ts}）の双方から再利用する。コメント内・文字列内・
 * `it.skip`/`todo`/条件付き無効化・未呼び出し関数内などの「証跡になり得ない」記述は
 * 除外し、実際に登録・実行される `it`/`test` のタイトルに含まれるIDだけを収集する。
 */

export interface TestCaseDefinition {
  readonly file: string;
  readonly position: number;
}

/**
 * `12_テスト戦略.md`「テストケースID」の`<LEVEL>-<SUBJECT>-<NUMBER>`。
 *
 * `API`（API契約テスト）を含むのは、この層のIDが一意性検査の外に居ると
 * 同じIDを別のテストが名乗っても誰も気づかないため（REL-004／Issue #203で
 * `API-OPENAPI-005`〜`008`が実際に各2回使われていた）。同じ理由で`INT`（Worker・
 * Bootstrap統合テスト）・`APP`（アプリケーション層契約テスト）も含める
 * （`INT-WORKER-006`が実際に2回使われていた）。
 */
export const TEST_CASE_ID_PATTERN =
  /\b(?:UT|IT|INT|SCN|E2E|PROP|API|APP)-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;

/**
 * `TEST_CASE_ID_PATTERN`と同じプレフィックス集合だが、末尾セグメントに英小文字も
 * 許容する「候補トークン」用パターン。`API-CONTRACT-015b`のような小文字サフィックスは
 * `TEST_CASE_ID_PATTERN`から見て語境界で途切れる（末尾セグメントが2つなら丸ごと
 * 不可視、3つ以上ならサフィックスだけ落ちて前方一致IDに化ける）ため、書式検査
 * （`UT-TRACEABILITY-010`）は実際に書かれた完全なトークンをこちらで捕捉する。
 */
export const LOOSE_TEST_CASE_ID_PATTERN =
  /\b(?:UT|IT|INT|SCN|E2E|PROP|API|APP)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g;
const NON_EXECUTING_TEST_MODIFIERS = new Set(["skip", "skipIf", "todo", "runIf"]);
export const VITEST_TEST_FUNCTIONS = new Set(["it", "test"]);
const VITEST_SUITE_FUNCTIONS = new Set(["describe", "suite"]);

function functionRootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return functionRootIdentifier(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return functionRootIdentifier(expression.expression);
  }
  return undefined;
}

function hasVitestFunctionRoot(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  expectedImports: ReadonlySet<string>,
): boolean {
  const root = functionRootIdentifier(expression);
  if (root === undefined) {
    return false;
  }
  const hasMatchingImport = root
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "vitest" &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (element) =>
            element.name.text === root.text &&
            expectedImports.has(element.propertyName?.text ?? element.name.text),
        ),
    );
  if (!hasMatchingImport) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(root);
  return (
    symbol?.declarations?.some((declaration) => {
      if (!ts.isImportSpecifier(declaration)) {
        return false;
      }
      let ancestor: ts.Node | undefined = declaration.parent;
      while (ancestor !== undefined && !ts.isImportDeclaration(ancestor)) {
        ancestor = ancestor.parent;
      }
      return (
        ancestor !== undefined &&
        ts.isImportDeclaration(ancestor) &&
        ts.isStringLiteral(ancestor.moduleSpecifier) &&
        ancestor.moduleSpecifier.text === "vitest" &&
        expectedImports.has(declaration.propertyName?.text ?? declaration.name.text)
      );
    }) === true
  );
}

/**
 * `[...] as const` / `(...)` / `<T>(...)` / `... satisfies T` のような、意味を変えない
 * ラッパーを剥がして中身の式を返す。`it.each([...] as const)(...)` のようなテーブルを
 * 配列リテラルとして解釈できるようにする。
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

/**
 * `it.each(識別子)`の識別子を、同一ファイル内の`const`宣言までTypeCheckerの
 * シンボル解決で辿り、配列リテラルの初期化子であればそれを返す。`let`/`var`や
 * 関数呼び出し・他ファイルからのimportなど、実行前に値が変わりうる／静的に
 * 配列の中身を確認できないものは解決しない（`undefined`を返す）。
 */
function resolveConstArrayLiteral(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.ArrayLiteralExpression | undefined {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations;
  if (declarations === undefined || declarations.length !== 1) {
    return undefined;
  }
  const declaration = declarations[0]!;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const initializer = unwrapExpression(declaration.initializer);
  return ts.isArrayLiteralExpression(initializer) ? initializer : undefined;
}

/**
 * `it.each`/`test.each`のテーブル引数を解決する。テーブルを静的な配列リテラルへ
 * 解決できたときだけ`"array"`を返し、テーブルが無い（`it.each`ではない）ときは
 * `"none"`、それ以外（`let`宣言・他ファイル由来・関数呼び出しの戻り値など、実行有無を
 * 静的に断定できないもの）は`"unresolved"`を返す。`"unresolved"`はタイトル文字列からの
 * ID収集は妨げない（呼び出し側が判断する）が、テーブル行からのID収集はできない。
 */
type ParameterizedTable =
  | { readonly kind: "none" }
  | { readonly kind: "array"; readonly node: ts.ArrayLiteralExpression }
  | { readonly kind: "unresolved" };

function parameterizedTable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ParameterizedTable {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    (expression.expression.name.text === "each" || expression.expression.name.text === "for")
  ) {
    const table = expression.arguments[0];
    if (table === undefined) {
      return { kind: "none" };
    }
    const unwrapped = unwrapExpression(table);
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return { kind: "array", node: unwrapped };
    }
    if (ts.isIdentifier(unwrapped)) {
      const resolved = resolveConstArrayLiteral(unwrapped, checker);
      return resolved === undefined ? { kind: "unresolved" } : { kind: "array", node: resolved };
    }
    return { kind: "unresolved" };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return parameterizedTable(expression.expression, checker);
  }
  if (ts.isCallExpression(expression)) {
    return parameterizedTable(expression.expression, checker);
  }
  return { kind: "none" };
}

/**
 * 実行対象と判定済みの `it.each`/`test.each` について、静的な配列リテラルテーブルの
 * 文字列リテラルに含まれるテストケースIDを、その定義位置とともに収集する。
 * タイトルが `"%s: ..."` のようにテーブル列を参照する場合、IDはタイトル文字列ではなく
 * テーブル行のセルに存在するため、こちらから抽出する必要がある。
 */
function parameterizedCaseIdLiterals(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  pattern: RegExp,
): [string, number][] {
  const table = parameterizedTable(expression, checker);
  if (table.kind !== "array") {
    return [];
  }
  const found: [string, number][] = [];
  const sourceFile = table.node.getSourceFile();
  function scan(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const match of node.text.matchAll(pattern)) {
        found.push([match[0], node.getStart(sourceFile)]);
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(table.node);
  return found;
}

function hasExecutableParameterizedCases(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const table = parameterizedTable(expression, checker);
  if (table.kind !== "array") {
    return true;
  }
  return (
    table.node.elements.length > 0 &&
    table.node.elements.every((element) => !ts.isSpreadElement(element))
  );
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function hasStaticallyExecutingOptions(options: ts.ObjectLiteralExpression): boolean {
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      return false;
    }
    const name = propertyNameText(property.name);
    if (ts.isComputedPropertyName(property.name) && name === undefined) {
      return false;
    }
    if (name === "skip" || name === "todo") {
      if (
        !ts.isPropertyAssignment(property) ||
        property.initializer.kind !== ts.SyntaxKind.FalseKeyword
      ) {
        return false;
      }
    }
  }
  return true;
}

function isInlineCallback(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function hasStaticallyExecutingCallback(call: ts.CallExpression): boolean {
  const optionsOrCallback = call.arguments[1];
  if (isInlineCallback(optionsOrCallback)) {
    return true;
  }
  return (
    optionsOrCallback !== undefined &&
    ts.isObjectLiteralExpression(optionsOrCallback) &&
    hasStaticallyExecutingOptions(optionsOrCallback) &&
    isInlineCallback(call.arguments[2])
  );
}

function hasNonExecutingModifier(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      NON_EXECUTING_TEST_MODIFIERS.has(expression.name.text) ||
      hasNonExecutingModifier(expression.expression)
    );
  }
  if (ts.isCallExpression(expression)) {
    return hasNonExecutingModifier(expression.expression);
  }
  return false;
}

function isInsideNonExecutingSuite(node: ts.Node, checker: ts.TypeChecker): boolean {
  let ancestor = node.parent;
  while (ancestor !== undefined) {
    if (
      ts.isCallExpression(ancestor) &&
      hasVitestFunctionRoot(ancestor.expression, checker, VITEST_SUITE_FUNCTIONS) &&
      (hasNonExecutingModifier(ancestor.expression) ||
        !hasExecutableParameterizedCases(ancestor.expression, checker) ||
        !hasStaticallyExecutingCallback(ancestor))
    ) {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function isSuiteCallback(
  node: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === node) &&
    hasVitestFunctionRoot(parent.expression, checker, VITEST_SUITE_FUNCTIONS) &&
    !hasNonExecutingModifier(parent.expression) &&
    hasExecutableParameterizedCases(parent.expression, checker) &&
    hasStaticallyExecutingCallback(parent)
  );
}

function isConditionalRegistrationAncestor(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isSwitchStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCatchClause(node) ||
    // `try { if (true) throw ...; it(...) } catch {}`のように、tryブロック内の
    // 到達可能性はifなど任意の文の組み合わせで静的に判定しきれない。個々の文を
    // 精査するのではなく、TryStatement配下（try/catch/finally）全体を保守的に
    // 「証跡になり得ない」として扱う。
    ts.isTryStatement(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  );
}

/**
 * `{ throw new Error(); it("ID", ...); }`や
 * `describe("suite", () => { if (cond) return; it("ID", ...); })`、
 * `switch (process.env.MODE) { case "skip": return; } it("ID", ...);`の
 * ように、先行する兄弟文がthrow/return/break/continueや、それらへ辿り着き得る
 * if/switch/while/for/try/finally/labeled statementであれば、後続の`it`/`test`
 * 呼び出しが本当に登録されるかは静的に保証できない。これらはテスト呼び出しの
 * 祖先ではなく先行する兄弟文なので`isConditionalRegistrationAncestor`（祖先だけを
 * 見る）では捉えられず、かといって「exitし得る構文」を個別に列挙していくやり方は
 * 際限がなく取りこぼしを生み続ける（過去のレビューでif→switch/while/for/
 * try-finally/labeled statementと繰り返し指摘された）。
 *
 * そこで発想を反転し、「後続文へ必ず読み進む」と静的に保証できる文の種類だけを
 * 許可リストとして持ち、それ以外の構文（分岐・ループ・例外・ラベルジャンプを
 * 含み得るもの）はすべて一律で「後続の到達可能性を保証できないもの」として
 * 保守的に扱う。
 */
const CONTROL_FLOW_SAFE_STATEMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.EmptyStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment,
]);

function isControlFlowSafeStatement(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) {
    return statement.statements.every(isControlFlowSafeStatement);
  }
  return CONTROL_FLOW_SAFE_STATEMENT_KINDS.has(statement.kind);
}

function hasUnsafePrecedingStatement(block: ts.Block | ts.SourceFile, child: ts.Node): boolean {
  const index = block.statements.indexOf(child as ts.Statement);
  if (index <= 0) {
    return false;
  }
  for (let i = 0; i < index; i++) {
    if (!isControlFlowSafeStatement(block.statements[i]!)) {
      return true;
    }
  }
  return false;
}

function isConditionallyRegisteredTest(node: ts.Node, checker: ts.TypeChecker): boolean {
  let child: ts.Node = node;
  let ancestor = node.parent;
  while (ancestor !== undefined) {
    if (isConditionalRegistrationAncestor(ancestor)) {
      return true;
    }
    if (
      (ts.isBlock(ancestor) || ts.isSourceFile(ancestor)) &&
      hasUnsafePrecedingStatement(ancestor, child)
    ) {
      return true;
    }
    if (ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) {
      if (!isSuiteCallback(ancestor, checker)) {
        return true;
      }
    } else if (
      ts.isFunctionDeclaration(ancestor) ||
      ts.isMethodDeclaration(ancestor) ||
      ts.isGetAccessorDeclaration(ancestor) ||
      ts.isSetAccessorDeclaration(ancestor) ||
      ts.isConstructorDeclaration(ancestor)
    ) {
      return true;
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
}

export function collectTestCaseDefinitionsFromSource(
  sourceText: string,
  file: string,
  pattern: RegExp = TEST_CASE_ID_PATTERN,
): readonly [string, TestCaseDefinition][] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.getSourceFile = () => sourceFile;
  compilerHost.fileExists = () => true;
  compilerHost.readFile = () => undefined;
  const checker = ts.createProgram([file], compilerOptions, compilerHost).getTypeChecker();
  const definitions: [string, TestCaseDefinition][] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      hasVitestFunctionRoot(node.expression, checker, VITEST_TEST_FUNCTIONS) &&
      !hasNonExecutingModifier(node.expression) &&
      hasExecutableParameterizedCases(node.expression, checker) &&
      hasStaticallyExecutingCallback(node) &&
      !isInsideNonExecutingSuite(node, checker) &&
      !isConditionallyRegisteredTest(node, checker)
    ) {
      const title = node.arguments[0];
      if (
        title !== undefined &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
      ) {
        for (const match of title.text.matchAll(pattern)) {
          definitions.push([match[0], { file, position: title.getStart(sourceFile) }]);
        }
      }
      // `it.each([["UT-...", ...]])("%s: ...", ...)` のように、IDがタイトルではなく
      // 静的テーブルのセルに存在するパラメタライズドテストからも収集する。
      for (const [id, position] of parameterizedCaseIdLiterals(node.expression, checker, pattern)) {
        definitions.push([id, { file, position }]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return definitions;
}

export function collectTestCaseDefinitions(
  directory: string,
  into = new Map<string, TestCaseDefinition[]>(),
  pattern: RegExp = TEST_CASE_ID_PATTERN,
): Map<string, TestCaseDefinition[]> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectTestCaseDefinitions(path, into, pattern);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
      continue;
    }
    for (const [id, definition] of collectTestCaseDefinitionsFromSource(
      readFileSync(path, "utf8"),
      path,
      pattern,
    )) {
      const definitions = into.get(id) ?? [];
      definitions.push(definition);
      into.set(id, definitions);
    }
  }
  return into;
}
