# -*- coding: utf-8 -*-
# Speed: colored-marker veto is now applied ONLY to cells that finally
# resolve as BLACK (the rare candidates), instead of a full 0.44r color-area
# scan for every one of the 225 cells before decideColor. Empty cells and
# white stones skip the expensive scan entirely. The white-body exemption
# (printed move numbers on white stones) stays intact.
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-vision\src\gbadaptive.cpp"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

# 1) remove the per-cell pre-decision veto
old1 = """            if (coloredMarked(xo, yo) && whiteByBody(xo, yo) != WHITE) { GB_TRACE(col, row, "REJECT decoration"); return; }
            auto dc = decideColor(patch, coreM, ringM, ringSec, thrCell);"""
new1 = """            auto dc = decideColor(patch, coreM, ringM, ringSec, thrCell);"""
if old1 not in s:
    print("MISSING step1"); raise SystemExit(1)
s = s.replace(old1, new1, 1)

# 2) unified veto at the final commit point (only when result is BLACK)
old2 = """            GB_TRACE(col, row, "COMMIT color=%d -> %d", (int)color, refC);
            board.at<int8_t>(row, col) = (int8_t)refC;"""
new2 = """            if (refC == BLACK && coloredMarked(xo, yo) && whiteByBody(xo, yo) != WHITE) {
                GB_TRACE(col, row, "REJECT decoration(black)");
                return;
            }
            GB_TRACE(col, row, "COMMIT color=%d -> %d", (int)color, refC);
            board.at<int8_t>(row, col) = (int8_t)refC;"""
if old2 not in s:
    print("MISSING step2"); raise SystemExit(1)
s = s.replace(old2, new2, 1)

with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print("gbadaptive.cpp: colored veto moved to BLACK-only commit point")
