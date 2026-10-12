#!/usr/bin/env bash
# Follow the ?webpage= -> /fn? token path (folder-authenticated, NO password needed).
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
PWD="15"

JAR="$(pwd)/_dltest7_cookies.txt"
rm -f "$JAR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest7_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest7_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest7_folder.html | sed -E "s/.*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest7_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest7_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
LIST=$(curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE")
FPATH=$(printf '%s' "$LIST" | grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/')
echo "FPATH=[$FPATH]"

echo
echo "=== GET /itDh84ad20ej?webpage=... (folder-authed page) ==="
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API/$FPATH" -o _dltest7_web.html -w "HTTP %{http_code}\n"
FNTOKEN=$(grep -oE "/fn\?[^\"'> ]+" _dltest7_web.html | head -1 | sed -E 's#/fn\?##')
echo "FNTOKEN=[${FNTOKEN:0:40}...]"

echo
echo "=== GET /fn?FNTOKEN (the iframe) ==="
curl -s -i -b "$JAR" -c "$JAR" -A "$UA" -e "$API/$FPATH" "$API/fn?$FNTOKEN" -o _dltest7_fn.html -w "HTTP %{http_code}\n"
echo "--- /fn page bytes ---"
wc -c _dltest7_fn.html
echo "--- grep sign/dom/url/down/ajax in /fn page ---"
grep -nE "isngis|down_p|dom|ajaxfile|ajaxm|var fid|sign|下载|href" _dltest7_fn.html | head -30
