#!/usr/bin/env python3
# svg-anim-sample.py —— svg-anim-probe.mjs 的采样后端。
# 读入 JSON 配置（帧路径 + 采样点 + 阈值），用 Pillow 逐帧逐点测：
#   delta = 采样方框内峰值亮度 - 本底参考点亮度（扣除背景）
#   area  = 方框内 delta >= threshold 的像素数（反映视觉尺寸）
# 输出 JSON：{ "<时刻>": [ {delta, area}, ... ] }，与配置中 points 顺序一致。
import json
import sys

from PIL import Image


def main():
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    radius = int(cfg["radius"])
    threshold = int(cfg["threshold"])
    dx = int(cfg["refDx"])
    dy = int(cfg["refDy"])

    result = {}
    for frame in cfg["frames"]:
        im = Image.open(frame["path"]).convert("RGB")
        px = im.load()
        W, H = im.size
        per_point = []
        for p in cfg["points"]:
            x, y = int(p["x"]), int(p["y"])
            # 本底参考点：同点偏移，越界时钳到边缘
            bx = min(max(x + dx, 0), W - 1)
            by = min(max(y + dy, 0), H - 1)
            bg = max(px[bx, by])
            vals = []
            for a in range(max(x - radius, 0), min(x + radius + 1, W)):
                for b in range(max(y - radius, 0), min(y + radius + 1, H)):
                    vals.append(max(px[a, b]))
            peak = max(vals)
            area = sum(1 for v in vals if v - bg >= threshold)
            per_point.append({"delta": peak - bg, "area": area})
        result[str(frame["t"])] = per_point
    print(json.dumps(result))


if __name__ == "__main__":
    main()
