#!/usr/bin/env sh
set -eu

VERSION="${VERSION:-0.1.0}"
ARCH="${ARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}"
case "$ARCH" in
    x86_64) ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
esac

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BUILD_DIR="${ROOT}/dist/debroot"
PACKAGE_DIR="${ROOT}/dist"
PACKAGE_NAME="jellyfin-log-collector_${VERSION}_${ARCH}.deb"

rm -rf "$BUILD_DIR"
mkdir -p \
    "$BUILD_DIR/DEBIAN" \
    "$BUILD_DIR/usr/bin" \
    "$BUILD_DIR/etc/jellyfin-log-collector" \
    "$BUILD_DIR/lib/systemd/system" \
    "$BUILD_DIR/var/lib/jellyfin-log-collector/uploads"

GOARCH="$ARCH"
[ "$GOARCH" = "amd64" ] && GOARCH=amd64
[ "$GOARCH" = "arm64" ] && GOARCH=arm64

(cd "$ROOT" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" go build -trimpath -ldflags="-s -w" -o "$BUILD_DIR/usr/bin/jellyfin-log-collector" .)

install -m 0644 "$ROOT/config.toml" "$BUILD_DIR/etc/jellyfin-log-collector/config.toml"
install -m 0644 "$ROOT/jellyfin-log-collector.service" "$BUILD_DIR/lib/systemd/system/jellyfin-log-collector.service"
install -m 0755 "$ROOT/debian/postinst" "$BUILD_DIR/DEBIAN/postinst"
install -m 0755 "$ROOT/debian/prerm" "$BUILD_DIR/DEBIAN/prerm"
install -m 0755 "$ROOT/debian/postrm" "$BUILD_DIR/DEBIAN/postrm"

cat > "$BUILD_DIR/DEBIAN/control" <<EOF_CONTROL
Package: jellyfin-log-collector
Version: ${VERSION}
Section: web
Priority: optional
Architecture: ${ARCH}
Maintainer: MotoFactory <admin@motofactory.net>
Description: Jellyfin playback diagnostics upload collector
 Small HTTP service that validates Jellyfin users and stores compact playback diagnostics uploads.
EOF_CONTROL

dpkg-deb --build "$BUILD_DIR" "$PACKAGE_DIR/$PACKAGE_NAME"
printf '%s\n' "$PACKAGE_DIR/$PACKAGE_NAME"
