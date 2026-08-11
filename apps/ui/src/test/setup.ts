import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  // 編成入力はlocalStorageへ自動保存される（01_UI要求・画面設計.md §5.9）。
  // jsdomのstorageはtest間で共有されるため、前のtestが保存したdraftが次のtestの
  // 初期状態になるのを防ぐ（06_UIテスト戦略.md §4）。
  window.localStorage.clear();
});
