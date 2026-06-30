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
# What it does:
#   1. Resolves the version (or bumps + commits it when an arg is given).
#   2. Builds the signed app + updater artifacts.
#   3. Tags the released commit on the current branch and pushes branch + tag.
#   4. Creates/updates the GitHub Release with the artifacts + latest.json.
#
# Usage:
#   ./scripts/release.sh                 # version read from tauri.conf.json
#   ./scripts/release.sh 2.2.0           # bump + commit version, then release
#   ./scripts/release.sh -f              # overwrite an existing tag/release
#   ./scripts/release.sh 2.2.0 -f        # bump + overwrite
#   RELEASE_NOTES="Fixes X, adds Y" ./scripts/release.sh
#
# By default the script refuses to release a version whose tag already exists
# (local or on origin). Re-run with -f / --force to move the tag and overwrite
# the release assets.
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

# --- Parse args (positional version + optional -f/--force) -------------------
FORCE=0
VERSION_ARG=""
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) VERSION_ARG="$arg" ;;
  esac
done

# `npm run release -f` is consumed by npm itself (it reads -f as --force) and
# never reaches this script, but npm exposes it as npm_config_force=true.
# Honor it so both `npm run release -f` and `npm run release -- -f` work.
[[ "${npm_config_force:-}" == "true" ]] && FORCE=1

# --- Resolve / bump version -------------------------------------------------
read_version() { node -p "require('./$CONF').version"; }

if [[ -n "$VERSION_ARG" ]]; then
  VERSION="$VERSION_ARG"
  echo "==> Bumping version to $VERSION"
  "$(dirname "$0")/bump-version.sh" "$VERSION"
  git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  if git diff --cached --quiet; then
    echo "==> Version already $VERSION; nothing to commit"
  else
    git commit -m "chore(release): v$VERSION"
  fi
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

# The tag + build must reflect a committed state, so refuse a dirty tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

# Refuse to clobber an existing release tag (local or origin) unless forced.
TAG_EXISTS=0
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || [[ -n "$(git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null)" ]]; then
  TAG_EXISTS=1
fi
if [[ "$TAG_EXISTS" == "1" && "$FORCE" != "1" ]]; then
  echo "ERROR: tag $TAG already exists (local or origin)." >&2
  echo "       To overwrite this release, re-run with -f:" >&2
  echo "         ./scripts/release.sh ${VERSION_ARG:+$VERSION_ARG }-f" >&2
  exit 1
fi

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

# --- Tag the released commit + push -----------------------------------------
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || echo "WARNING: releasing from '$BRANCH', not 'main'"

git push origin "$BRANCH"

if [[ "$TAG_EXISTS" == "1" ]]; then
  echo "==> Overwriting existing tag $TAG → $COMMIT (-f)"
  git tag -f -a "$TAG" -m "$TAG" "$COMMIT"
  git push -f origin "$TAG"
else
  echo "==> Tagging $COMMIT as $TAG"
  git tag -a "$TAG" -m "$TAG" "$COMMIT"
  git push origin "$TAG"
fi

# --- Publish ----------------------------------------------------------------
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "==> Release $TAG exists; uploading/overwriting assets"
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$STAGE/$DMG_ASSET" "$STAGE/$TARGZ_ASSET" "$STAGE/latest.json"
else
  echo "==> Creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes "$NOTES" \
    --target "$COMMIT" \
    "$STAGE/$DMG_ASSET" "$STAGE/$TARGZ_ASSET" "$STAGE/latest.json"
fi

echo "==> Done. Manifest: https://github.com/$REPO/releases/latest/download/latest.json"
