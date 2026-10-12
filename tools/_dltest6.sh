#!/usr/bin/env bash
# Test: open file page WITH the ?webpage= token from folder listing; see if password is bypassed.
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
PWD="15"

JAR="$(pwd)/_dltest6_cookies.txt"
rm -f "$JAR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# unlock folder, capture file id + webpage token
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest6_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest6_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest6_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest6_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest6_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
LIST=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE")
echo "LIST(first 400): ${LIST:0:400}"

# extract file page path + webpage token
FPATH=$(printf '%s' "$LIST" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "FPATH=[$FPATH]"
WEBPAGE=$(printf '%s' "$FPATH" | sed -E 's/.*\?webpage=([^"]+)/\1/')
BASEFP=$(printf '%s' "$FPATH" | sed -E 's/\?webpage=.*//')
echo "BASEFP=[$BASEFP] WEBPAGE=[${WEBPAGE:0:30}...]"

echo
echo "=== GET file page WITHOUT webpage token ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$BASEFP" -o _dltest6_file_noweb.html -w "HTTP %{http_code}\n"

echo "=== GET file page WITH webpage token ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$FPATH" -o _dltest6_file_web.html -w "HTTP %{http_code}\n"
echo "--- diff signs ---"
SIGN_NOWEB=$(grep -oE "var isngis = '[^']+'" _dltest6_file_web.html _dltest6_file_noweb.html 2>/dev/null; grep -oE "var isngis = '[^']+'" _dltest6_file_noweb.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
SIGN_WEB=$(grep -oE "var isngis = '[^']+'" _dltest6_file_web.html | head -1 | sed -E "s/.*'([^']*)'/\1/")
echo "SIGN_NOWEB(len=${#SIGN_NOWEB}) SIGN_WEB(len=${#SIGN_WEB})"

echo "--- does webpage file page contain an auto-download link or different down_p? ---"
grep -nE "downajax|dom|url|感谢|直链|直接下载|auto" _dltest6_file_web.html | head

echo
echo "=== ajaxfile with p=15 using WEBPAGE-page sign ==="
REAL_FILE_ID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest6_file_web.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "REAL_FILE_ID=[$REAL_FILE_ID]"
RESP=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API/$FPATH" \
  -H "X-Requested-With: XMLHttpRequest" \
  --data-urlencode "action=downprocess" --data-urlencode "sign=$SIGN_WEB" \
  --data-urlencode "kd=1" --data-urlencode "p=$PWD" \
  "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" -w "\nHTTP %{http_code}\n")
echo "$RESP"
