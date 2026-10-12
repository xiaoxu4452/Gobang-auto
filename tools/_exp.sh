#!/usr/bin/env bash
# 受控实验：全链 curl + 验证页 el=1 重试循环（仿浏览器 reload 语义）
set -u
cd "$(dirname "$0")"
API="https://wwbbj.lanzout.com"; SHARE="/b016l49aqj"; PWD="15"
JAR="$(pwd)/_exp_cookies.txt"; rm -f "$JAR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
PY="/c/Users/harve/.workbuddy/binaries/python/versions/3.13.12/python.exe"

curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _exp_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _exp_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _exp_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _exp_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _exp_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
UID=$(grep -oE "uid':'[^']+'" _exp_folder.html | head -1 | sed -E "s/uid':'([^']+)'/\1/")
LIST=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=$UID" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" "$API/filemoreajax.php?file=$FILE")
FPATH=$(printf '%s' "$LIST" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "file entry: $FPATH" | head -c 80; echo
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$FPATH" -o _exp_web.html
FNTOK=$(grep -oE '/fn\?[^"'"'"'> ]+' _exp_web.html | head -1 | sed -E 's#/fn\?##')
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/$FPATH" "$API/fn?$FNTOK" -o _exp_fn.html
WPS=$(grep -oE "var wp_sign = '[^']+'" _exp_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
AJD=$(grep -oE "var ajaxdata = '[^']+'" _exp_fn.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
FID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _exp_fn.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/fn?$FNTOK" \
  --data-urlencode "action=downprocess" --data-urlencode "websignkey=$AJD" \
  --data-urlencode "signs=$AJD" --data-urlencode "sign=$WPS" \
  --data-urlencode "websign=2" --data-urlencode "kd=1" --data-urlencode "ves=1" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$FID")
DOM=$(printf '%s' "$RESP" | grep -o '"dom"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
URL=$(printf '%s' "$RESP" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
LINK="$DOM/file/$URL"
echo "LINK=${LINK:0:70}..."
HOST6="${DOM#https://}"

# step6: acw challenge loop
for a in 1 2 3; do
  CHAL=$(curl -s --compressed -b "$JAR" -c "$JAR" -A "$UA" -e "$API/" "$LINK")
  ARG1=$(printf '%s' "$CHAL" | grep -oE "arg1='[0-9A-Fa-f]+'" | head -1 | sed -E "s/arg1='([^']*)'/\1/")
  if [ -n "$ARG1" ]; then
    V=$("$PY" -c "
import sys
arg1=sys.argv[1]
m=[15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36]
mask='3000176000856006061501533003690027800375'
u=''.join(arg1[p-1] for p in m)
print(''.join('%02x'%(int(u[i:i+2],16)^int(mask[i:i+2],16)) for i in range(0,len(u),2)))
" "$ARG1")
    printf '%s\tTRUE\t/\tFALSE\t0\tacw_sc__v2\t%s\n' "$HOST6" "$V" >> "$JAR"
  else
    echo "no arg1 on attempt $a (maybe already past challenge)"; break
  fi
done
VERIFY=$(curl -s --compressed -b "$JAR" -c "$JAR" -A "$UA" -e "$API/" "$LINK" -o _exp_verify.html -w "%{http_code}")
echo "verify GET: $VERIFY bytes=$(wc -c < _exp_verify.html)"

# step7 loop: fresh page each try, el=1 then fallback el=2/3
for i in 1 2 3 4 6; do
  curl -s --compressed -b "$JAR" -c "$JAR" -A "$UA" -e "$API/" "$LINK" -o _exp_verify.html
  FTOK=$(grep -oE "'file':'[^']+'" _exp_verify.html | head -1 | sed -E "s/'file':'([^']*)'/\1/")
  FSIGN=$(grep -oE "'sign':'[^']+'" _exp_verify.html | head -1 | sed -E "s/'sign':'([^']*)'/\1/")
  for EL in 1 2 3; do
    R=$(curl -s --compressed -b "$JAR" -c "$JAR" -A "$UA" -H "X-Requested-With: XMLHttpRequest" \
      -e "$LINK" --data-urlencode "file=$FTOK" --data-urlencode "el=$EL" --data-urlencode "sign=$FSIGN" \
      "$DOM/file/ajax.php")
    echo "try$i el=$EL: $(printf '%s' "$R" | head -c 130)"
    if printf '%s' "$R" | grep -q '"zt":1'; then
      RU=$(printf '%s' "$R" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/' | sed 's#\\/#/#g')
      if [ -n "$RU" ] && [ "$RU" != "?SignError" ]; then
        echo "REAL=$RU"
        curl -s -L -A "$UA" -e "$LINK/" -o _exp_final.exe "$RU" -w "DL HTTP %{http_code} size=%{size_download}\n"
        head -c 4 _exp_final.exe | od -An -tx1
        exit 0
      fi
    fi
  done
done
echo "ALL RETRIES FAILED"
