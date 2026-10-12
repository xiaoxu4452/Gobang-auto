#!/usr/bin/env bash
# Try multiple ajax download endpoints/domains with pwd=15 to find what the server accepts.
set -u
cd "$(dirname "$0")"

API="https://wwbbj.lanzout.com"
SHARE="/b016l49aqj"
FILE_PAGE="/itDh84ad20ej"
PWD="15"

JAR="$(pwd)/_dltest5_cookies.txt"
rm -f "$JAR"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# folder unlock (seed cookies)
curl -s -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$SHARE" -o _dltest5_folder.html
T=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest5_folder.html | sed -E "s/var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'([0-9a-f]+)'/\1/" | head -1)
K=$(grep -oE "var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'[0-9a-f]+'" _dltest5_folder.html | sed -E "s/var [a-zA-Z0-9_]+[[:space:]]*=[[:space:]]*'([0-9a-f]+)'/\1/" | sed -n '2p')
FILE=$(grep -oE "file=[0-9]+" _dltest5_folder.html | head -1 | sed -E 's/file=([0-9]+)/\1/')
PUID=$(grep -oE "puid':'[^']+'" _dltest5_folder.html | head -1 | sed -E "s/puid':'([^']+)'/\1/")
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" \
  --data-urlencode "lx=2" --data-urlencode "fid=$FILE" --data-urlencode "uid=4801414" \
  --data-urlencode "puid=$PUID" --data-urlencode "pg=1" --data-urlencode "rep=0" \
  --data-urlencode "t=$T" --data-urlencode "k=$K" --data-urlencode "up=1" \
  --data-urlencode "ls=1" --data-urlencode "pwd=$PWD" \
  "$API/filemoreajax.php?file=$FILE" -o /dev/null

# file page sign
curl -s -b "$JAR" -c "$JAR" -A "$UA" -e "$API$SHARE" "$API$FILE_PAGE" -o _dltest5_file.html
SIGN=$(grep -oE "var isngis = '[^']+'" _dltest5_file.html | head -1 | sed -E "s/var isngis = '([^']*)'/\1/")
REAL_FILE_ID=$(grep -oE "ajaxfile\.php\?file=[0-9]+" _dltest5_file.html | head -1 | sed -E 's/.*file=([0-9]+)/\1/')
echo "SIGN(len=${#SIGN}) REAL_FILE_ID=[$REAL_FILE_ID]"

post () {
  local label="$1"; local url="$2"; local field="$3"
  echo
  echo "### $label"
  echo "    url=$url  field=$field=$PWD"
  curl -s -i -b "$JAR" -c "$JAR" -A "$UA" -e "$API$FILE_PAGE" \
    -H "X-Requested-With: XMLHttpRequest" -H "Accept: application/json, text/javascript, */*; q=0.01" \
    --data-urlencode "action=downprocess" --data-urlencode "sign=$SIGN" \
    --data-urlencode "kd=1" --data-urlencode "$field=$PWD" \
    "$url" 2>&1 | sed -n '1,40p' | grep -E "HTTP/|Set-Cookie|\{.*\}" | head -20
}

post "A apifile.woozooo.com/ajaxfile.php  p"   "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" "p"
post "B wwbbj.lanzout.com/ajaxm.php       pwd" "$API/ajaxm.php?file=$REAL_FILE_ID" "pwd"
post "C wwbbj.lanzout.com/ajaxfile.php    pwd" "$API/ajaxfile.php?file=$REAL_FILE_ID" "pwd"
post "D apifile.woozooo.com/ajaxfile.php  pwd" "https://apifile.woozooo.com/ajaxfile.php?file=$REAL_FILE_ID" "pwd"
post "E wwbbj.lanzout.com/ajaxm.php       p"   "$API/ajaxm.php?file=$REAL_FILE_ID" "p"
