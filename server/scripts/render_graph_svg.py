#!/usr/bin/env python3
import json
import math
import re
import sys
from html import escape

WIDTH, HEIGHT = 620, 340
M = {"top": 24, "right": 30, "bottom": 44, "left": 52}
plot_left = M["left"]
plot_right = WIDTH - M["right"]
plot_top = M["top"]
plot_bottom = HEIGHT - M["bottom"]
plot_w = plot_right - plot_left
plot_h = plot_bottom - plot_top

SAFE_EXPR = re.compile(r"^[0-9xXyYtT+\-*/^()., _a-zA-Z]+$")
ALLOWED_FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
    "exp": math.exp, "abs": abs, "floor": math.floor, "ceil": math.ceil,
}


def nice_interval(span: float) -> float:
    if span <= 0:
        return 1.0
    rough = span / 8.0
    mag = 10 ** math.floor(math.log10(rough))
    norm = rough / mag
    if norm <= 1:
        n = 1
    elif norm <= 2:
        n = 2
    elif norm <= 3:
        n = 2.5
    elif norm <= 7.5:
        n = 5
    else:
        n = 10
    return n * mag


def compile_expr(expr: str):
    src = (expr or "").strip()
    src = re.sub(r"^y\s*=\s*", "", src, flags=re.I)
    src = src.replace("^", "**").replace("π", "pi")
    src = src.replace("Math.", "")
    src = src.replace("ln(", "log(")
    if not SAFE_EXPR.match(src):
        return None

    def fn(xv: float, yv: float = 0.0, tv: float = 0.0):
        env = {
            "__builtins__": {},
            **ALLOWED_FUNCS,
            "pi": math.pi,
            "e": math.e,
            "x": xv,
            "X": xv,
            "y": yv,
            "Y": yv,
            "t": tv,
            "T": tv,
        }
        try:
            val = eval(src, env, {})
            val = float(val)
            if math.isfinite(val):
                return val
            return None
        except Exception:
            return None

    return fn


def to_svg(spec: dict) -> str:
    x_min, x_max = spec.get("xRange", [-5, 5])
    y_min, y_max = spec.get("yRange", [-5, 5])
    if x_min >= x_max:
        x_min, x_max = -5, 5
    if y_min >= y_max:
        y_min, y_max = -5, 5

    axis = spec.get("axisLabels") or {"x": "x", "y": "y"}
    x_label = str(axis.get("x") or "x")
    y_label = str(axis.get("y") or "y")
    tick = float(spec.get("tickInterval") or 0) or None
    x_tick = tick if tick and tick > 0 else nice_interval(x_max - x_min)
    y_tick = tick if tick and tick > 0 else nice_interval(y_max - y_min)

    def x_to_svg(x):
        return plot_left + ((x - x_min) / (x_max - x_min)) * plot_w

    def y_to_svg(y):
        return plot_bottom - ((y - y_min) / (y_max - y_min)) * plot_h

    x_axis_y = min(max(y_to_svg(0), plot_top), plot_bottom)
    y_axis_x = min(max(x_to_svg(0), plot_left), plot_right)

    items = []
    items.append(f'<rect x="0" y="0" width="{WIDTH}" height="{HEIGHT}" fill="#ffffff"/>')
    items.append(f'<rect x="{plot_left}" y="{plot_top}" width="{plot_w}" height="{plot_h}" fill="#ffffff" stroke="#d1d5db" stroke-width="1"/>')

    if spec.get("showGrid", True):
        xv = math.ceil(x_min / x_tick) * x_tick
        while xv <= x_max + 1e-9:
            sx = x_to_svg(xv)
            items.append(f'<line x1="{sx:.2f}" x2="{sx:.2f}" y1="{plot_top}" y2="{plot_bottom}" stroke="#edf2f7" stroke-width="1"/>')
            xv += x_tick
        yv = math.ceil(y_min / y_tick) * y_tick
        while yv <= y_max + 1e-9:
            sy = y_to_svg(yv)
            items.append(f'<line x1="{plot_left}" x2="{plot_right}" y1="{sy:.2f}" y2="{sy:.2f}" stroke="#edf2f7" stroke-width="1"/>')
            yv += y_tick

    items.append(f'<line x1="{plot_left}" x2="{plot_right}" y1="{x_axis_y:.2f}" y2="{x_axis_y:.2f}" stroke="#111827" stroke-width="1.4"/>')
    items.append(f'<line x1="{y_axis_x:.2f}" x2="{y_axis_x:.2f}" y1="{plot_top}" y2="{plot_bottom}" stroke="#111827" stroke-width="1.4"/>')

    xv = math.ceil(x_min / x_tick) * x_tick
    while xv <= x_max + 1e-9:
        sx = x_to_svg(xv)
        items.append(f'<line x1="{sx:.2f}" x2="{sx:.2f}" y1="{x_axis_y - 4:.2f}" y2="{x_axis_y + 4:.2f}" stroke="#374151" stroke-width="1"/>')
        if abs(xv) > 1e-9:
            items.append(f'<text x="{sx:.2f}" y="{x_axis_y + 16:.2f}" font-size="10" text-anchor="middle" fill="#374151">{escape(f"{xv:g}")}</text>')
        xv += x_tick

    yv = math.ceil(y_min / y_tick) * y_tick
    while yv <= y_max + 1e-9:
        sy = y_to_svg(yv)
        items.append(f'<line x1="{y_axis_x - 4:.2f}" x2="{y_axis_x + 4:.2f}" y1="{sy:.2f}" y2="{sy:.2f}" stroke="#374151" stroke-width="1"/>')
        if abs(yv) > 1e-9:
            items.append(f'<text x="{y_axis_x - 8:.2f}" y="{sy + 3:.2f}" font-size="10" text-anchor="end" fill="#374151">{escape(f"{yv:g}")}</text>')
        yv += y_tick

    items.append(f'<text x="{plot_right + 12}" y="{x_axis_y + 4:.2f}" font-size="12" fill="#111827">{escape(x_label)}</text>')
    items.append(f'<text x="{y_axis_x + 8:.2f}" y="{plot_top - 8}" font-size="12" fill="#111827">{escape(y_label)}</text>')

    curves = spec.get("curves") or []
    if not curves and spec.get("equation"):
        curves = [{"equation": spec.get("equation"), "label": spec.get("label") or ""}]

    palette = ["#0284c7", "#7c3aed", "#059669", "#ea580c"]
    legend = []

    for idx, curve in enumerate(curves):
        eq = str(curve.get("equation") or "").strip()
        if not eq:
            continue
        fn = compile_expr(eq)
        if not fn:
            continue
        color = str(curve.get("color") or palette[idx % len(palette)])
        label = str(curve.get("label") or "").strip()
        path_parts = []
        pen = False
        prev_y = None
        y_span = y_max - y_min
        for i in range(601):
            x = x_min + ((x_max - x_min) * i / 600.0)
            y = fn(x)
            if y is None:
                pen = False
                prev_y = None
                continue
            if prev_y is not None and abs(y - prev_y) > y_span * 2.25:
                pen = False
                prev_y = y
                continue
            if y < y_min - y_span * 0.25 or y > y_max + y_span * 0.25:
                pen = False
                prev_y = y
                continue
            sx, sy = x_to_svg(x), y_to_svg(y)
            path_parts.append(("L" if pen else "M") + f" {sx:.2f} {sy:.2f}")
            pen = True
            prev_y = y

        if path_parts:
            items.append(f'<path d="{" ".join(path_parts)}" fill="none" stroke="{escape(color)}" stroke-width="2.2"/>')
            if label:
                legend.append((label, color))

    points = (spec.get("points") or []) + (spec.get("highlightedPoints") or [])
    for p in points:
        try:
            x = float(p.get("x"))
            y = float(p.get("y"))
        except Exception:
            continue
        if not math.isfinite(x) or not math.isfinite(y):
            continue
        sx, sy = x_to_svg(x), y_to_svg(y)
        items.append(f'<circle cx="{sx:.2f}" cy="{sy:.2f}" r="3.2" fill="#111827"/>')
        lab = str(p.get("label") or "").strip()
        if lab:
            items.append(f'<text x="{sx + 6:.2f}" y="{sy - 6:.2f}" font-size="10" fill="#111827">{escape(lab)}</text>')

    if legend:
        lx, ly = plot_right - 120, plot_top + 12
        items.append(f'<rect x="{lx - 8}" y="{ly - 10}" width="128" height="{len(legend) * 18 + 10}" fill="#ffffff" opacity="0.92" stroke="#e5e7eb"/>')
        for i, (lab, color) in enumerate(legend):
            y = ly + i * 18
            items.append(f'<line x1="{lx}" x2="{lx + 16}" y1="{y:.2f}" y2="{y:.2f}" stroke="{escape(color)}" stroke-width="2.2"/>')
            items.append(f'<text x="{lx + 22}" y="{y + 3:.2f}" font-size="10" fill="#111827">{escape(lab)}</text>')

    return "".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" width="{WIDTH}" height="{HEIGHT}">',
        *items,
        "</svg>",
    ])


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw else {}
        spec = payload.get("spec") if isinstance(payload, dict) else None
        if not isinstance(spec, dict):
            print(json.dumps({"ok": False, "error": "Invalid payload"}))
            return
        svg = to_svg(spec)
        print(json.dumps({"ok": True, "svg": svg}))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
