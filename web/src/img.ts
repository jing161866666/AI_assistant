/**
 * 本地图片 → data URL（与改错页同一口径：最长边 1600、JPEG 0.85）。
 *
 * 错题本"补传截图"用它：手机原图动辄 4–8 MB，直接 base64 传会被后端的 8MB 上限挡掉。
 */
export async function fileToDataUrl(file: File, maxSide = 1600): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
