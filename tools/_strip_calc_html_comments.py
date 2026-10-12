# -*- coding: utf-8 -*-
import io
p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\calc.html"
with io.open(p, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')

drop_exact = {
    '/* Meter Gomoku Trainer - overlay UI page (board canvas, status panel, control buttons). */',
    '  // \u2605 2026-09-20\uff08\u7528\u6237\u8981\u6c42\uff09\uff1a\u81ea\u5b9a\u4e49\u7684\u68cb\u76d8 / \u9875\u9762\u5e95\u8272\u4e5f\u8981**\u9996\u5e27**\u5c31\u843d\u4e0a\u3002',
    '  //   \u4e0a\u4e00\u8f6e calc.js \u5df2\u7ecf\u628a\u300c\u4ed6\u6311\u7684\u90a3\u4e2a\u989c\u8272 \u2192 \u4e00\u6574\u5957 CSS \u53d8\u91cf\u300d\u7b97\u597d\u5b58\u8fdb S.cssVars\uff0c',
    '  //   \u8fd9\u91cc**\u539f\u6837\u56de\u653e**\u5373\u53ef\uff08\u4e0d\u5fc5\u5728\u8fd9\u91cc\u518d\u5199\u4e00\u904d\u989c\u8272\u6570\u5b66\uff09\uff0c\u4e8e\u662f\u4e0d\u4f1a\u5148\u95ea\u4e00\u4e0b\u9ed8\u8ba4\u62a4\u773c\u9ec4\u3002',
    '  // \u590d\u76d8\u7a97\uff08?rv=1\uff09/ \u8bc6\u56fe\u7a97\uff08?vis=1\uff09\u7684\u906e\u7f69\u6587\u5b57\u6362\u6210\u5b83\u4eec\u81ea\u5df1\u7684\u82f1\u6587\u540d\uff08\u89c1\u4e0b\u9762 #boot \u540e\u90a3\u884c\u5185\u8054\u811a\u672c\uff09',
    '/* \u590d\u76d8\u7a97\uff08?rv=1\uff09/ \u8bc6\u56fe\u7a97\uff08?vis=1\uff09\u52a0\u8f7d\u65f6\u906e\u7f69\u4e0a\u7684\u540d\u5b57\u4e0e\u7a97\u53e3\u6807\u9898\u5404\u81ea\u6362\u6389',
    '   \uff08\u6837\u5f0f\u540c\u6b3e\uff1a\u659c\u4f53/\u52a0\u7c97/\u7070\u84dd\uff09\u3002 */',
}
out = [l for l in lines if l not in drop_exact]
# also drop the multi-line comment start/end leftovers generically (none should remain)
with io.open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write('\n'.join(out))
print('lines:', len(lines), '->', len(out))
