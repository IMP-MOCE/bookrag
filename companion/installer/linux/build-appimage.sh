#!/usr/bin/env bash
# Сборка AppImage компаньона. Запускать из каталога companion/:
#
#   ./installer/linux/build-appimage.sh [version]
#
# Если версия не передана, берётся "dev". appimagetool скачивается в
# ~/.cache/bookrag-companion при первом запуске.
#
# Зависимости: bash, curl или wget, fuse2 (для запуска самого AppImage —
# не нужен для сборки), стандартные coreutils.

set -euo pipefail

VERSION="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPDIR_SRC="$ROOT/installer/linux/AppDir"
WORK="$ROOT/dist/linux/AppDir"
OUT_DIR="$ROOT/dist/linux"
TOOL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/bookrag-companion"
TOOL_PATH="$TOOL_CACHE/appimagetool"

mkdir -p "$OUT_DIR" "$TOOL_CACHE"

# 1. Сборка бинаря с версией.
echo ">> go build companion v$VERSION"
(
  cd "$ROOT"
  CGO_ENABLED=1 go build \
    -ldflags "-X github.com/bookrag/companion/internal/buildinfo.Version=$VERSION" \
    -o "$WORK/usr/bin/bookrag-companion" \
    ./cmd/bookrag-companion
)

# 2. Раскладка AppDir по spec: AppRun на корне, .desktop на корне,
# иконка на корне (имя без расширения = Icon= в .desktop).
cp "$APPDIR_SRC/AppRun" "$WORK/AppRun"
chmod +x "$WORK/AppRun"
cp "$APPDIR_SRC/bookrag-companion.desktop" "$WORK/bookrag-companion.desktop"
cp "$ROOT/assets/icon.png" "$WORK/bookrag-companion.png"

# 3. appimagetool: скачиваем при первом запуске.
if [ ! -x "$TOOL_PATH" ]; then
  echo ">> fetching appimagetool"
  URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TOOL_PATH"
  else
    wget -q "$URL" -O "$TOOL_PATH"
  fi
  chmod +x "$TOOL_PATH"
fi

# 4. Сборка .AppImage. --appimage-extract-and-run обходит требование FUSE
# в CI-окружении (на десктопе тоже работает).
OUTPUT="$OUT_DIR/BookRAG_Companion-${VERSION}-x86_64.AppImage"
ARCH=x86_64 "$TOOL_PATH" --appimage-extract-and-run "$WORK" "$OUTPUT"
echo ">> wrote $OUTPUT"
