#!/bin/sh
# 사용법: sh store/render.sh
#   store/*.html → 구글 플레이용 1080×1920 PNG (store/), 앱스토어용 1284×2778 PNG (store/ios/)
cd "$(dirname "$0")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
mkdir -p ios
shot() { # $1 html, $2 출력 png, $3 창 크기
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --window-size="$3" --force-device-scale-factor=1 \
    --screenshot="$(cygpath -w "$PWD/$2")" "file:///$(cygpath -m "$PWD/$1")" 2>/dev/null
}
for f in [0-9]-*.html; do
  shot "$f" "${f%.html}.png" 1080,1920
  shot "$f" "ios/${f%.html}.png" 1284,2778
done
