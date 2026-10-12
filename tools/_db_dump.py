# -*- coding: utf-8 -*-
"""直接翻被污染的开局库：schema + 含天元 H8（编码 h7）的记录。"""
import sqlite3, sys, os, shutil

SRC = r"C:\Users\harve\Desktop\Gobang auto\Meter GomokuTrainer\rapfi-native\rapfi.db.poisoned-bak"
TMP = os.path.join(os.environ["TEMP"], "gb_db_dump.db")
shutil.copyfile(SRC, TMP)
con = sqlite3.connect(TMP)
cur = con.cursor()
print("== schema ==")
for r in cur.execute("SELECT type,name,sql FROM sqlite_master"):
    print(" ", r[0], r[1])
    if r[2]:
        print("   ", " ".join(str(r[2]).split())[:300])

print("\n== 各表行数 ==")
tabs = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
for t in tabs:
    try:
        n = cur.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
        print("  %-14s %d" % (t, n))
    except Exception as e:
        print("  %-14s ERR %s" % (t, e))

# 找记录表
for t in tabs:
    cols = [c[1] for c in cur.execute("PRAGMA table_info(%s)" % t)]
    if not cols:
        continue
    print("\n== 表 %s 列: %s ==" % (t, cols))
    keycol = None
    for c in cols:
        if c.lower() in ("key", "board", "position", "hash"):
            keycol = c
    if keycol is None:
        continue
    n = cur.execute("SELECT COUNT(*) FROM %s WHERE %s LIKE '%%h7%%'" % (t, keycol)).fetchone()[0]
    print("   含天元(h7)的记录: %d" % n)
    for row in cur.execute("SELECT * FROM %s WHERE %s LIKE '%%h7%%' LIMIT 40" % (t, keycol)):
        print("   ", row)
con.close()
