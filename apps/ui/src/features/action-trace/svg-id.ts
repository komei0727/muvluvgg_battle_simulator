/**
 * `useId`の値をSVGの`url(#id)`で参照できる形へ寄せる。`useId`はコロンなどを含み得るため、
 * そのまま`url()`へ入れると参照が解決されないブラウザがある。
 */
export function svgIdOf(reactId: string): string {
  return `trace-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}
