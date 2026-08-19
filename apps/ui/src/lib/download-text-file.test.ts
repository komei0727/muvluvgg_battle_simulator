import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile } from "./download-text-file.js";

// jsdomは`URL.createObjectURL`を実装しない。差し替えた分は記述子ごと戻す。
const originalDescriptors = {
  createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
};

afterEach(() => {
  for (const [name, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(URL, name);
    } else {
      Object.defineProperty(URL, name, descriptor);
    }
  }
});

function stubObjectUrl() {
  const createObjectURL = vi.fn(() => "blob:generated");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  return { createObjectURL, revokeObjectURL };
}

// UI-UT-CSV-004: 生成したCSVは`a[download]`で渡す。作ったobject URLは同じ操作の中で
// 開放する（開放しないとタブを閉じるまでBlobが残る）。
describe("downloadTextFile", () => {
  it("hands the text to the browser as a named download and releases the object url", () => {
    const { createObjectURL, revokeObjectURL } = stubObjectUrl();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const started = downloadTextFile("runs.csv", "text/csv", "a,b\n1,2\n");

    expect(started).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:generated");
    expect(document.body.querySelector("a")).toBeNull();
    click.mockRestore();
  });

  // object URLを作れない環境では黙って何も起きないより、呼び出し側が案内を出せる
  // ようにする。
  it("reports that it could not start a download without object url support", () => {
    Object.defineProperty(URL, "createObjectURL", { value: undefined, configurable: true });

    expect(downloadTextFile("runs.csv", "text/csv", "a,b\n")).toBe(false);
  });
});
