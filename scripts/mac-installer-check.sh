#!/usr/bin/env bash
# The Mac disk image, checked on a throwaway GitHub Actions macOS runner the way she will
# use it, one step at a time (.github/workflows/release.yml, job mac-installer). It refuses
# to run anywhere else: it starts the app, which shows its window.
#
#   scripts/mac-installer-check.sh mount <dmg>   mounts the image (hidden from Finder), checks
#                                                its volume, copies the app out of it into a
#                                                folder of this check's own
#   scripts/mac-installer-check.sh verify        the copied app: identity, version, minimum
#                                                macOS, icon, ad-hoc signature without the
#                                                hardened runtime, both architectures
#   scripts/mac-installer-check.sh launch        starts it hidden (open -g -j), natively
#   scripts/mac-installer-check.sh launch-x64    starts its Intel (x86_64) code hidden, under Rosetta
#   scripts/mac-installer-check.sh cleanup       quits anything left, detaches the image and
#                                                removes only what this check made
#
# Each launch uses a temporary profile (--user-data-dir), checks that the app's main process
# and its renderer start and stay up, then quits the app and checks that nothing of it is
# left running; on any failure it stops the app and removes the profile first. Everything
# the check makes is in one folder in $RUNNER_TEMP, which mount makes (and refuses to reuse)
# and cleanup removes; nothing in /Applications or elsewhere on the runner is touched.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${CI:-}" != "true" ] || [ -z "${RUNNER_TEMP:-}" ]; then
  echo "scripts/mac-installer-check.sh runs only on a GitHub Actions runner (it starts the app, which shows its window). Refused." >&2
  exit 1
fi

APP_ID="io.github.juliocesar97db.aba-workbench"
PRODUCT="ABA Workbench"
# Electron 45's own minimum, which README.md, docs/macos.md and the release notes promise.
MINIMUM_MACOS="13.0"
STATE="$RUNNER_TEMP/aba-mac-installer-check"
APP="$STATE/Applications/$PRODUCT.app"
VERSION=$(node -p "require('./package.json').version")
# Folders the app could make outside its profile: the default cases folder (the packaged
# app ignores --home-folder) and macOS's saved window state. Removed by cleanup only when
# mount found them absent, so only what the app made during this check goes.
OUTSIDE=("$HOME/$PRODUCT" "$HOME/Library/Saved Application State/$APP_ID.savedState")

fail() {
  echo "::error::$*"
  exit 1
}

# The PIDs of every process whose executable's path contains $1 (a fixed string, not a
# pattern). The executable (comm), not the command line, so awk's own arguments never match.
pids_with() {
  ps -axo pid=,comm= | awk -v s="$1" 'index($0, s) { print $1 }'
}

# Stops every process of the copied app, if any.
stop_app() {
  local pids
  pids=$(pids_with "$APP/Contents/")
  if [ -n "$pids" ]; then
    echo "Stopping what is left of the app: $(echo "$pids" | paste -sd ' ' -)."
    echo "$pids" | xargs kill -KILL 2> /dev/null || true
  fi
}

# What the app and macOS said, for a failed launch.
show_app_logs() {
  echo "::group::The app's log messages and crash reports"
  log show --last 5m --style compact --predicate "process BEGINSWITH \"$PRODUCT\"" 2> /dev/null | tail -n 200 || true
  find "$HOME/Library/Logs/DiagnosticReports" -name "$PRODUCT*" -mmin -10 -print -exec head -n 80 {} \; 2> /dev/null || true
  echo "::endgroup::"
}

mount_image() {
  local dmg=$1
  [ -f "$dmg" ] || fail "No disk image at $dmg."
  [ ! -e "$STATE" ] || fail "$STATE is already there; this check only works in a folder it makes itself."
  mkdir -p "$STATE/Applications"
  local path
  for path in "${OUTSIDE[@]}"; do
    if [ ! -e "$path" ]; then echo "$path" >> "$STATE/absent-before"; fi
  done
  hdiutil verify "$dmg"
  mkdir "$STATE/volume"
  # -nobrowse: never shown in Finder; -noautoopen: no window opens for it.
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$STATE/volume" "$dmg"
  touch "$STATE/mounted"
  echo "Mounted at $STATE/volume:"
  ls -la "$STATE/volume"

  # electron-builder's default window (owner's decision, 2026-11-23): the app, and a
  # shortcut to Applications to drag it onto, in a volume named after the app and version.
  local volume
  volume=$(diskutil info "$STATE/volume" | awk -F': *' '/Volume Name/ { print $2 }')
  [ "$volume" = "$PRODUCT $VERSION" ] || fail "The volume is named '$volume', not '$PRODUCT $VERSION'."
  [ -d "$STATE/volume/$PRODUCT.app" ] || fail "The image has no $PRODUCT.app."
  [ -L "$STATE/volume/Applications" ] && [ "$(readlink "$STATE/volume/Applications")" = "/Applications" ] || fail "The image has no shortcut to /Applications."

  # As she drags it out of the image, but into this check's own folder, not /Applications.
  ditto "$STATE/volume/$PRODUCT.app" "$APP"
  echo "Copied the app to $APP."
}

verify_app() {
  [ -d "$APP" ] || fail "No app at $APP."
  local plist="$APP/Contents/Info.plist"
  local id version minimum icon
  id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$plist")
  version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")
  minimum=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$plist")
  icon=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$plist")
  [ "$id" = "$APP_ID" ] || fail "The app's identifier is $id, not $APP_ID."
  [ "$version" = "$VERSION" ] || fail "The app's version is $version, not $VERSION."
  [ "$minimum" = "$MINIMUM_MACOS" ] || fail "The app needs macOS $minimum, not $MINIMUM_MACOS: update README.md, docs/macos.md and the release notes, then MINIMUM_MACOS here."
  cmp "$APP/Contents/Resources/$icon" packaging/macos/icon.icns || fail "The app's icon ($icon) is not packaging/macos/icon.icns."
  echo "Identifier $id, version $version, macOS $minimum or later, icon $icon."

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

  # The hardened runtime is off (owner's decision, 2026-11-23), for the app and each helper
  # app it starts: its CodeDirectory flags say "runtime" when it is on.
  local bundle flags
  for bundle in "$APP" "$APP/Contents/Frameworks/"*.app; do
    flags=$(codesign --display --verbose=4 "$bundle" 2>&1 | grep "^CodeDirectory" || true)
    [ -n "$flags" ] || fail "$bundle has no code signature."
    if [[ "$flags" == *runtime* ]]; then fail "$bundle has the hardened runtime on: $flags"; fi
    [[ "$flags" == *adhoc* ]] || fail "$bundle is not signed ad-hoc: $flags"
  done
  echo "The app and its helper apps are signed ad-hoc, without the hardened runtime."

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

# The end of a launch step, whatever ended it (the EXIT trap): after a failure, what the app
# said; then the app stopped, if it still runs, and its profile removed.
LAUNCH_PROFILE=""
end_launch() {
  local status=$?
  if [ "$status" -ne 0 ]; then show_app_logs; fi
  stop_app
  if [ -n "$LAUNCH_PROFILE" ]; then rm -rf "$LAUNCH_PROFILE"; fi
  exit "$status"
}

# Starts the copied app hidden through LaunchServices, as a double-click does, but in the
# background (-g) and hidden (-j); -n a new instance; then checks it runs, and quits it.
# $1 is the label, $2 "native" or "translated": whether the main process must run under
# Rosetta, and $3... open's options for the architecture.
launch_and_quit() {
  local label=$1 expected=$2
  shift 2
  # Rosetta translates the app's code as it first runs it, and on a runner's virtual Mac that
  # is slow: the first release run started the Intel renderer after 95 seconds and was still
  # starting up 30 seconds after being asked to quit (native: 2 seconds and 1 second).
  local start_limit=120 idle_limit=60 quit_limit=30
  if [ "$expected" = "translated" ]; then
    start_limit=300
    idle_limit=300
    quit_limit=180
  fi
  [ -d "$APP" ] || fail "No app at $APP."
  [ -z "$(pids_with "$APP/Contents/")" ] || fail "The app is already running."
  local profile
  profile=$(mktemp -d "$STATE/profile.XXXXXX")
  local main="$APP/Contents/MacOS/$PRODUCT"
  local renderer="$APP/Contents/Frameworks/$PRODUCT Helper (Renderer).app/"
  # On any failure from here: what the app said, then stop it and remove its profile.
  LAUNCH_PROFILE=$profile
  trap end_launch EXIT

  open -g -j -n "$@" "$APP" --args "--user-data-dir=$profile"

  # Its main process, then its renderer (a separate helper app, with its own signature).
  local waited=0
  until [ -n "$(pids_with "$renderer")" ]; do
    if [ "$waited" -ge "$start_limit" ]; then
      ps -o pid=,command= -p "$(pids_with "$PRODUCT" | paste -sd, -)" || true
      fail "$label: the app's renderer had not started after $start_limit seconds."
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
  ps -o pid=,flags=,command= -p "$(pids_with "$APP/Contents/" | paste -sd, -)" || true

  # Under Rosetta or not: macOS marks a translated process with P_TRANSLATED (0x20000,
  # <sys/proc.h>) in its flags, which ps shows in hexadecimal.
  local flags translated=native
  flags=$(ps -o flags= -p "$pid" | tr -d ' ')
  if (((16#$flags & 0x20000) != 0)); then translated=translated; fi
  [ "$translated" = "$expected" ] || fail "$label: the app's main process (flags $flags) runs $translated, not $expected."
  echo "$label: the main process runs $translated (flags $flags)."
  [ -n "$(find "$profile" -mindepth 1 -print -quit)" ] || fail "$label: the app wrote nothing in its profile $profile."

  # The interface done loading: its renderer idle (under 10% CPU) for 10 seconds in a row.
  # Quitting asks the interface to save what is waiting and gives it 5 seconds to answer
  # (src/main/close-guard.ts); a page still busy loading under Rosetta could not, and the app
  # would then ask her about unsaved changes in a dialog, which nobody answers here.
  local renderer_pid cpu quiet=0
  waited=0
  renderer_pid=$(pids_with "$renderer" | head -n 1)
  while [ "$quiet" -lt 10 ]; do
    [ "$waited" -lt "$idle_limit" ] || fail "$label: the app's renderer was still busy $idle_limit seconds after it started."
    cpu=$(ps -o %cpu= -p "$renderer_pid" | tr -d ' ') || fail "$label: the app's renderer is gone."
    if [ "${cpu%%.*}" -lt 10 ]; then quiet=$((quiet + 1)); else quiet=0; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$label: the interface is idle ($waited seconds after the check above)."

  # Quits it as macOS does when the user logs out (SIGTERM lets Electron close normally).
  kill -TERM "$pid"
  waited=0
  while [ -n "$(pids_with "$APP/Contents/")" ]; do
    if [ "$waited" -ge "$quit_limit" ]; then fail "$label: the app was still running $quit_limit seconds after it was asked to quit."; fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$label: quit after $waited seconds; nothing of it is left running."
}

cleanup() {
  if [ ! -d "$STATE" ]; then
    echo "Nothing to clean up: the mount step never ran."
    return
  fi
  stop_app
  if [ -f "$STATE/mounted" ]; then
    hdiutil detach "$STATE/volume" || hdiutil detach -force "$STATE/volume"
  fi
  local path
  if [ -f "$STATE/absent-before" ]; then
    while IFS= read -r path; do
      if [ -e "$path" ]; then
        echo "Removing $path, which the app made during this check."
        rm -rf "$path"
      fi
    done < "$STATE/absent-before"
  fi
  rm -rf "$STATE"
  echo "Detached the image and removed the check's folder $STATE."
}

case "${1:-}" in
  mount) mount_image "${2:?the disk image}" ;;
  verify) verify_app ;;
  launch) launch_and_quit "Native" native ;;
  launch-x64)
    # The Intel code, under Rosetta on this Apple Silicon runner, as an Intel Mac runs it.
    [ "$(uname -m)" = "arm64" ] || fail "This step needs an Apple Silicon runner."
    arch -x86_64 /usr/bin/true || fail "Rosetta is not installed on this runner, so the app's Intel code cannot be started."
    launch_and_quit "Intel (Rosetta)" translated --arch x86_64
    ;;
  cleanup) cleanup ;;
  *) fail "Usage: $0 mount <dmg> | verify | launch | launch-x64 | cleanup" ;;
esac
