# -*- coding: utf-8 -*-
# 1) Remove the final color guard in readFull (it triggers realign side effects).
# 2) Arbitrate prefers the adaptive reader when valid (legacy only as fallback
#    when adaptive is suspect/invalid), so corner logos blocked by adaptive
#    never leak through legacy.
# 3) redMarked center threshold 0.10 -> 0.18 (a selection ring around a stone
#    has low red in the disc center; cross arms fill the disc).
import io

base = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src"

# ---- 1) remove guard ----
p = base + r"\gbrecognize.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    src = f.read()

start = src.find("        // Final color guard: a stone never stands on a cell whose disc is")
end = src.find("        Json invL = invariants(pickedOut.board);", start)
if start < 0 or end < 0:
    print("MISSING: guard block not found"); raise SystemExit(1)
src = src[:start] + "        Json invL = invariants(pickedOut.board);" + src[end + len("        Json invL = invariants(pickedOut.board);"):]
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print("1) guard removed")

# ---- 2) arbitrate: adaptive preferred ----
old_arb = """    if (susA && !susB) { out = secondary; return "legacy"; }
    if (totA == 0 && totB > 0 && !susB) { out = secondary; return "legacy"; }
    out = primary;
    return "adaptive";"""
new_arb = """    if (susA && !susB) { out = secondary; return "legacy"; }
    out = primary;
    return "adaptive";"""
if old_arb not in src:
    print("MISSING: arbitrate block"); raise SystemExit(1)
src = src.replace(old_arb, new_arb, 1)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src)
print("2) arbitrate prefers adaptive")

# ---- 3) redMarked threshold ----
p2 = base + r"\gbadaptive.cpp"
with io.open(p2, 'r', encoding='utf-8') as f:
    src2 = f.read()
old_red = """    const double RED_MARKER_MIN = 0.10;
    const int redDiscR = iRound(spacing * 0.44);
    auto redMarked = [&](int ax, int ay) -> bool {
        return redMarkerFrac(ax, ay, redDiscR) >= RED_MARKER_MIN &&
               annulusRedFrac(ax, ay, 0.44, 0.62) >= 0.04;
    };"""
new_red = """    const double RED_MARKER_MIN = 0.18;
    const int redDiscR = iRound(spacing * 0.44);
    auto redMarked = [&](int ax, int ay) -> bool {
        return redMarkerFrac(ax, ay, redDiscR) >= RED_MARKER_MIN &&
               annulusRedFrac(ax, ay, 0.44, 0.62) >= 0.04;
    };"""
if old_red not in src2:
    print("MISSING: redMarked block"); raise SystemExit(1)
src2 = src2.replace(old_red, new_red, 1)
with io.open(p2, 'w', encoding='utf-8', newline='\n') as f:
    f.write(src2)
print("3) redMarked center threshold 0.18")
