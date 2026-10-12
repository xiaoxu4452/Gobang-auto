#!/usr/bin/env bash
set -u
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
SHARE="https://wwbbj.lanzout.com/b016l49aqj"
API="https://wwbbj.lanzout.com"
PWD1="15"
JAR=$(mktemp -p /tmp jar.XXXXXX.txt)
OUT="/c/Users/harve/AppData/Local/Temp/_dltest_out.bin"
rm -f "$OUT"

echo "=== 1) page GET (cookie jar) ==="
PAGE=$(curl -s -A "$UA" -c "$JAR" "$SHARE")
echo "page bytes=${#PAGE}"
echo "--- jar after page ---"; cat "$JAR" | sed 's/\t/ | /g'

FILE=$(echo "$PAGE" | grep -oE "filemoreajax\.php\?file=[0-9]+" | grep -oE "[0-9]+" | head -1)
FUID=$(echo "$PAGE" | grep -oE "uid['\"]?:['\"]?[0-9]+" | grep -oE "[0-9]+" | head -1)
PUID=$(echo "$PAGE" | grep -oE "puid['\"]?:['\"]?[^'\"]+" | head -1 | sed -E "s/.*['\"]:['\"]?//; s/['\"]$//")
# t,k = first two  var X='hex'  assignments
TK=$(echo "$PAGE" | grep -oE "var [a-zA-Z0-9_]+ ?= ?'[0-9a-f]+'" | grep -oE "'[0-9a-f]+'" | tr -d "'")
T=$(echo "$TK" | sed -n '1p'); K=$(echo "$TK" | sed -n '2p')
echo "FILE=$FILE FUID=$FUID PUID=$PUID T=$T K=${K:0:8}..."

echo "=== 2) filemoreajax (with pwd) ==="
BODY="lx=2&fid=$FILE&uid=$FUID&puid=$PUID&pg=1&rep=0&t=$T&k=$K&up=1&ls=1&pwd=$PWD1"
RESP=$(curl -s -A "$UA" -c "$JAR" -b "$JAR" -e "$SHARE" \
  --data "$BODY" "$API/filemoreajax.php?file=$FILE")
echo "ajax bytes=${#RESP}"
echo "RESP=$RESP" | head -c 400; echo

# parse names/ids/duans
mapfile -t NAMES < <(echo "$RESP" | grep -oE '"name_all":"[^"]+"' | sed -E 's/"name_all":"//; s/"$//')
mapfile -t IDS   < <(echo "$RESP" | grep -oE '"id":"[^"]+"' | sed -E 's/"id":"//; s/"$//')
mapfile -t DUANS < <(echo "$RESP" | grep -oE '"duan":"[^"]+"' | sed -E 's/"duan":"//; s/"$//')
echo "files found: ${#NAMES}"
for i in "${!NAMES[@]}"; do echo "  [$i] ${NAMES[$i]}  id=${IDS[$i]:0:12}.. duan=${DUANS[$i]:-}"; done

# choose best .exe
BEST=-1; BESTN=""; BESTID=""; BESTDUAN=""
for i in "${!NAMES[@]}"; do
  n="${NAMES[$i]}"; [[ "$n" == *.exe ]] || continue
  ver=$(echo "$n" | grep -oE "[0-9]+(\.[0-9]+){1,2}" | head -1)
  [ -z "$ver" ] && continue
  if [ "$BEST" = "-1" ] || awk "BEGIN{exit !($ver > $BEST)}"; then
    BEST=$ver; BESTN="$n"; BESTID="${IDS[$i]}"; BESTDUAN="${DUANS[$i]:-}";
  fi
done
echo "BEST installer=$BESTN id=$BESTID duan=$BESTDUAN"
FIDCLEAN=$(echo "$BESTID" | sed 's/?.*//')
echo "FIDCLEAN=$FIDCLEAN"

echo "=== 3) ajaxm.php variants ==="
for REF in "https://wwbbj.lanzout.com/$BESTDUAN" "$SHARE"; do
  for V in \
    "lx=0&fid=$FILE&uid=$FUID&pwd=$PWD1" \
    "lx=0&fid=$FILE&uid=$FUID&puid=$PUID&pwd=$PWD1" \
    "lx=0&fid=0&uid=$FUID&pwd=$PWD1" ; do
    R=$(curl -s -A "$UA" -c "$JAR" -b "$JAR" -e "$REF" --data "$V" "$API/ajaxm.php?file=$FIDCLEAN")
    DOM=$(echo "$R" | grep -oE '"dom"?[^,}]*' | head -1)
    echo "  REF=$REF  V=[$V]"
    echo "    resp=$R" | head -c 300; echo
    if echo "$R" | grep -q '"zt":1'; then echo "    >>> zt:1 FOUND"; break 2; fi
  done
done

echo "=== jar after ajaxm ==="; cat "$JAR" | sed 's/\t/ | /g'
rm -f "$JAR"
