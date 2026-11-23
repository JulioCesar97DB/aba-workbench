#!/usr/bin/env bash
# The Mac disk image, checked on a throwaway macOS runner the way she will use it, one step
# at a time (.github/workflows/release.yml, job mac-installer). Never run it on someone's
# own Mac: it copies the app into /Applications, starts it, and removes it again.
#
#   scripts/mac-installer-check.sh mount <dmg>   mounts the image (hidden from Finder), checks
#                                                its volume, copies the app to /Applications
#   scripts/mac-installer-check.sh verify        the copied app: ad-hoc signature, identity,
#                                                version, both architectures in every executable
#   scripts/mac-installer-check.sh launch        starts it hidden (open -g -j), natively
#   scripts/mac-installer-check.sh launch-x64    starts its Intel (x86_64) code under Rosetta
#   scripts/mac-installer-check.sh cleanup       removes the app and detaches the image
#
# Each launch uses a temporary profile (--user-data-dir), checks that the app's main process
# and its renderer start and stay up, then quits the app and checks that nothing of it is
# left running. The image's mount point is kept in $RUNNER_TEMP between steps.
set -euo pipefail

APP_ID="io.github.juliocesar97db.aba-workbench"
PRODUCT="ABA Workbench"
APP="/Applications/$PRODUCT.app"
STATE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/aba-mac-installer-check"
VERSION=$(node -p "require('./package.json').version")

fail() {
  echo "::error::$*"
  exit 1
}

# The PIDs of every process whose command line contains $1 (a fixed string, not a pattern).
pids_with() {
  ps -axo pid=,command= | awk -v s="$1" 'index($0, s) && !/awk -v s=/ { print $1 }'
}

mount_image() {
  local dmg=$1
  [ -f "$dmg" ] || fail "No disk image at $dmg."
  [ ! -e "$APP" ] || fail "$APP is already there; this check needs a runner without the app."
  hdiutil verify "$dmg"
  mkdir -p "$STATE"
  local mountpoint
  mountpoint=$(mktemp -d "$STATE/volume.XXXXXX")
  # -nobrowse: never shown in Finder; -noautoopen: no window opens for it.
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mountpoint" "$dmg"
  echo "$mountpoint" > "$STATE/mountpoint"
  echo "Mounted at $mountpoint:"
  ls -la "$mountpoint"

  # electron-builder's default window (owner's decision, 2026-11-23): the app, and a
  # shortcut to Applications to drag it onto, in a volume named after the app and version.
  local volume
  volume=$(diskutil info "$mountpoint" | awk -F': *' '/Volume Name/ { print $2 }')
  [ "$volume" = "$PRODUCT $VERSION" ] || fail "The volume is named '$volume', not '$PRODUCT $VERSION'."
  [ -d "$mountpoint/$PRODUCT.app" ] || fail "The image has no $PRODUCT.app."
  [ -L "$mountpoint/Applications" ] && [ "$(readlink "$mountpoint/Applications")" = "/Applications" ] || fail "The image has no shortcut to /Applications."

  # As she does it: the app, copied out of the image into Applications.
  ditto "$mountpoint/$PRODUCT.app" "$APP"
  echo "Copied the app to $APP."
}

verify_app() {
  [ -d "$APP" ] || fail "No app at $APP."
  local plist="$APP/Contents/Info.plist"
  local id version minimum
  id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$plist")
  version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")
  minimum=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$plist")
  [ "$id" = "$APP_ID" ] || fail "The app's identifier is $id, not $APP_ID."
  [ "$version" = "$VERSION" ] || fail "The app's version is $version, not $VERSION."
  echo "Identifier $id, version $version, macOS $minimum or later."

  # Ad-hoc signed (owner's decision, 2026-11-23): a whole, valid signature with no identity,
  # which Apple Silicon needs to run the app at all. Nothing is notarized.
  codesign --verify --deep --strict --verbose=2 "$APP"
  local details
  details=$(codesign --display --verbose=4 "$APP" 2>&1)
  echo "$details"
  grep -qx "Signature=adhoc" <<< "$details" || fail "The app's signature is not ad-hoc."
  grep -qx "Identifier=$APP_ID" <<< "$details" || fail "The app is not signed as $APP_ID."
  if grep -q "^Authority=" <<< "$details"; then fail "The app is signed with a certificate; it should only have an ad-hoc signature."; fi
  # Copied from an image built on this runner, so nothing marks it as downloaded.
  if xattr -p com.apple.quarantine "$APP" > /dev/null 2>&1; then fail "The copied app is quarantined."; fi

  # One universal app (owner's decision, 2026-11-23): every executable and library in it has
  # both an Apple Silicon (arm64) and an Intel (x86_64) slice.
  local count=0 file archs
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q "Mach-O"; then
      archs=$(lipo -archs "$file")
      [[ " $archs " == *" arm64 "* && " $archs " == *" x86_64 "* ]] || fail "$file has only: $archs."
      count=$((count + 1))
    fi
  done < <(find "$APP" -type f -print0)
  [ "$count" -gt 0 ] || fail "No executable found in $APP."
  echo "$count executables and libraries, each with arm64 and x86_64."
}

# Starts the app with "$@" (a command that starts it, given its own profile), checks it runs,
# then quits it.
launch_and_quit() {
  local label=$1
  shift
  mkdir -p "$STATE"
  local profile
  profile=$(mktemp -d "$STATE/profile.XXXXXX")
  local main="$APP/Contents/MacOS/$PRODUCT"
  local renderer="$APP/Contents/Frameworks/$PRODUCT Helper (Renderer).app/"

  [ -z "$(pids_with "$APP/Contents/")" ] || fail "The app is already running."
  "$@" "$profile"

  # Its main process, then its renderer (a separate helper app, with its own signature).
  local waited=0
  until [ -n "$(pids_with "$renderer")" ]; do
    if [ "$waited" -ge 120 ]; then
      ps -axo pid,command | grep -F "$PRODUCT" || true
      fail "$label: the app's renderer had not started after 120 seconds."
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$label: the renderer started after $waited seconds."
  # Still up a while later: it did not crash on start.
  sleep 15
  local pid
  pid=$(pids_with "$main" | head -n 1)
  [ -n "$pid" ] || fail "$label: the app's main process is gone 15 seconds after it started."
  [ -n "$(pids_with "$renderer")" ] || fail "$label: the app's renderer is gone 15 seconds after it started."
  echo "$label: still running after 15 seconds:"
  ps -o pid=,flags=,command= -p "$(pids_with "$APP/Contents/" | paste -sd, -)"
  [ -n "$(find "$profile" -mindepth 1 -print -quit)" ] || fail "$label: the app wrote nothing in its profile $profile."

  # Quits it as macOS does when the user logs out (SIGTERM lets Electron close normally).
  kill -TERM "$pid"
  waited=0
  while [ -n "$(pids_with "$APP/Contents/")" ]; do
    if [ "$waited" -ge 30 ]; then
      pids_with "$APP/Contents/" | xargs kill -KILL || true
      fail "$label: the app was still running 30 seconds after it was asked to quit."
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$label: quit after $waited seconds; nothing of it is left running."
  rm -rf "$profile"
}

# Hidden: -g keeps it in the background, -j starts it hidden; -n a new instance. Through
# LaunchServices, as a double-click starts it.
open_native() {
  open -g -j -n "$APP" --args "--user-data-dir=$1"
}

# The Intel code, under Rosetta on this Apple Silicon runner: arch runs the x86_64 slice or
# fails, never the arm64 one.
open_x64() {
  arch -x86_64 "$APP/Contents/MacOS/$PRODUCT" "--user-data-dir=$1" > "$STATE/x64.log" 2>&1 &
}

cleanup() {
  rm -rf "$APP"
  if [ -f "$STATE/mountpoint" ]; then
    local mountpoint
    mountpoint=$(cat "$STATE/mountpoint")
    hdiutil detach "$mountpoint" || hdiutil detach -force "$mountpoint"
    rm -f "$STATE/mountpoint"
  fi
  [ ! -e "$APP" ] || fail "$APP is still there."
  echo "Removed the app and detached the image."
}

case "${1:-}" in
  mount) mount_image "${2:?the disk image}" ;;
  verify) verify_app ;;
  launch) launch_and_quit "Native" open_native ;;
  launch-x64)
    [ "$(uname -m)" = "arm64" ] || fail "This step needs an Apple Silicon runner."
    arch -x86_64 /usr/bin/true || fail "Rosetta is not installed on this runner, so the app's Intel code cannot be started."
    launch_and_quit "Intel (Rosetta)" open_x64
    ;;
  cleanup) cleanup ;;
  *) fail "Usage: $0 mount <dmg> | verify | launch | launch-x64 | cleanup" ;;
esac
