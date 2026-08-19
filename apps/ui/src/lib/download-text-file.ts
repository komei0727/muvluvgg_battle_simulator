/**
 * 組み立てたテキストをファイルとして渡す。サーバーは統計を返さない（Q-TEX-16）ため、
 * 持ち出せる形はブラウザ側で作るしかない。
 *
 * `URL.createObjectURL`を持たない環境では`false`を返す。黙って何も起きないと、
 * 利用者は押し損ねたのか環境が対応していないのか区別できない。
 */
export function downloadTextFile(fileName: string, mediaType: string, text: string): boolean {
  if (typeof URL.createObjectURL !== "function") {
    return false;
  }

  const url = URL.createObjectURL(new Blob([text], { type: `${mediaType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // 開放しないとタブを閉じるまでBlobがメモリに残る。2,000試行のCSVは数MBになる。
    URL.revokeObjectURL(url);
  }
  return true;
}
