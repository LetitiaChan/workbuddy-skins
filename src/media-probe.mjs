// 图片二进制头解析：只读文件头判定「是否动图」与画布尺寸。
//
// 从 theme-store.mjs 拆出的理由：这是纯二进制格式解析，与「主题目录的列出与创建」
// 毫无关系。它原先被塞在 theme-store 里，只因为 theme-store 和 injector 都需要它——
// 于是 injector 为了一个图片探测函数反向依赖了存储层（层次倒置）。
// 现在两边都从本模块取，依赖方向摆正。
//
// 格式细节（均为实测）：
// GIF：宽高在头部 6-9 字节（LE uint16）；此处不分辨单帧/多帧，GIF 一律按动图处理
//   （当前内置主题均为 WebP，无实际影响；仅影响自定义 GIF 的「动图」标注与尺寸上限）
// 动态 WebP：VP8X chunk 画布尺寸在 24-29 字节（24 位 LE，存值 = 实际 - 1），
//   flags 字节 bit 0x02 为动画标记
// 动态 AVIF：ftyp 主品牌为 avis（静态为 avif），宽高在 meta 内的 ispe box
//   （BE uint32 宽高，位于 "ispe" 标记 +8/+12 处），在前 4KB 内搜索即可覆盖常规文件

import { open } from "node:fs/promises";

const ANIMATABLE_EXTENSIONS = [".gif", ".webp", ".avif", ".avifs"];

export async function probeAnimatedSize(imagePath, extension) {
  if (!ANIMATABLE_EXTENSIONS.includes(extension)) return null;
  const handle = await open(imagePath, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, 4096, 0);
    if (extension === ".gif") {
      if (bytesRead < 10 || header.toString("latin1", 0, 3) !== "GIF") return null;
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }
    if (extension === ".webp") {
      if (bytesRead < 30) return null;
      if (header.toString("latin1", 0, 4) !== "RIFF" || header.toString("latin1", 8, 12) !== "WEBP") return null;
      if (header.toString("latin1", 12, 16) !== "VP8X" || !(header[20] & 0x02)) return null; // 静态 WebP 不限制
      return { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3) };
    }
    if (bytesRead < 12 || header.toString("latin1", 4, 8) !== "ftyp") return null;
    if (header.toString("latin1", 8, 12) !== "avis") return null; // 静态 AVIF 不限制
    const ispe = header.indexOf("ispe", 12, "latin1");
    if (ispe < 0 || ispe + 16 > bytesRead) return null;
    return { width: header.readUInt32BE(ispe + 8), height: header.readUInt32BE(ispe + 12) };
  } finally {
    await handle.close();
  }
}
