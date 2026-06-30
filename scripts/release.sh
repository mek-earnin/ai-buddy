#!/usr/bin/env bash
#
# Local release: build the signed app + updater artifacts, generate the
# updater manifest (latest.json) and publish a GitHub Release.
#
# Prerequisites (one-time):
#   - Updater signing key at ~/.tauri/ai-buddy-updater.key (generated via
#     `npm run tauri signer generate`). Lose it = can't ship updates.
#   - `gh` CLI authenticated (`gh auth status`).
#   - Apple signing identity available; export APPLE_SIGNING_IDENTITY if your
#     identity name differs from the build default.
#
# Usage:
#   ./scripts/release.sh                 # version read from tauri.conf.json
#   ./scripts/release.sh 2.2.0           # explicit version (also bumps files)
#   RELEASE_NOTES="Fixes X, adds Y" ./scripts/release.sh
#
set -euo pipefail

REPO="mek-earnin/ai-buddy"
ARCH="aarch64"
TAURI_TARGET="aarch64-apple-darwin"
PRODUCT_NAME="AI Buddy"
# GitHub serves release assets with spaces in the filename replaced by dots, so
# stage uploads under the dotted name to keep asset name == download URL.
ASSET_BASE="AI.Buddy"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/ai-buddy-updater.key}"
CONF="src-tauri/tauri.conf.json"

# --- Resolve / bump version -------------------------------------------------
read_version() { node -p "require('./$CONF').version"; }

if [[ "${1:-}" != "" ]]; then
  VERSION="$1"
  echo "==> Bumping version to $VERSION in tauri.conf.json, package.json, Cargo.toml"
  node -e '
    const fs = require("fs");
    const v = process.argv[1];
    for (const f of ["src-tauri/tauri.conf.json", "package.json"]) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      j.version = v;
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    }
    const cargo = "src-tauri/Cargo.toml";
    let c = fs.readFileSync(cargo, "utf8");
    c = c.replace(/^version = ".*"$/m, `version = "${v}"`);
    fs.writeFileSync(cargo, c);
  ' "$VERSION"
else
  VERSION="$(read_version)"
fi

TAG="v$VERSION"
echo "==> Releasing $TAG"

# --- Preflight --------------------------------------------------------------
if [[ ! -f "$KEY_PATH" ]]; then
  echo "ERROR: updater signing key not found at $KEY_PATH" >&2
  exit 1
fi
command -v gh >/dev/null || { echo "ERROR: gh CLI not installed" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated" >&2; exit 1; }

# --- Build (signs .app with Apple identity + .app.tar.gz with updater key) ---
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

echo "==> Building (npm run tauri:build)"
npm run tauri:build

BUNDLE_DIR="src-tauri/target/$TAURI_TARGET/release/bundle"
DMG_SRC="$(ls "$BUNDLE_DIR"/dmg/*_"$ARCH".dmg | head -n1)"
TARGZ_SRC="$(ls "$BUNDLE_DIR"/macos/*.app.tar.gz | head -n1)"
SIG_SRC="$TARGZ_SRC.sig"

for f in "$DMG_SRC" "$TARGZ_SRC" "$SIG_SRC"; do
  [[ -f "$f" ]] || { echo "ERROR: expected artifact missing: $f" >&2; exit 1; }
done

# --- Stage assets under dotted names ----------------------------------------
STAGE="$ROOT_DIR/release"
rm -rf "$STAGE" && mkdir -p "$STAGE"
DMG_ASSET="${ASSET_BASE}_${VERSION}_${ARCH}.dmg"
TARGZ_ASSET="${ASSET_BASE}.app.tar.gz"
cp "$DMG_SRC" "$STAGE/$DMG_ASSET"
cp "$TARGZ_SRC" "$STAGE/$TARGZ_ASSET"

# --- Generate latest.json ---------------------------------------------------
SIGNATURE="$(cat "$SIG_SRC")"
NOTES="${RELEASE_NOTES:-AI Buddy $VERSION}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$TARGZ_ASSET"

SIGNATURE="$SIGNATURE" NOTES="$NOTES" VERSION="$VERSION" URL="$DOWNLOAD_URL" \
node -e '
  const fs = require("fs");
  const manifest = {
    version: process.env.VERSION,
    notes: process.env.NOTES,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": {
        signature: process.env.SIGNATURE,
        url: process.env.URL,
      },
    },
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + "\n");
' "$STAGE/latest.json"

echo "==> Staged assets:"
ls -1 "$STAGE"

# --- Publish ----------------------------------------------------------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> Release $TAG exists; uploading/overwriting assets"
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$STAGE/$DMG_ASSET" "$STAGE/$TARGZ_ASSET" "$STAGE/latest.json"
else
  echo "==> Creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "$NOTES" \
    "$STAGE/$DMG_ASSET" "$STAGE/$TARGZ_ASSET" "$STAGE/latest.json"
fi

echo "==> Done. Manifest: https://github.com/$REPO/releases/latest/download/latest.json"
