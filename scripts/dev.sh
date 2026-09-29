#!/bin/bash

# Generate a unique dev instance name
ADJECTIVES=("fuzzy" "sparkly" "bouncy" "wobbly" "zippy" "snazzy" "groovy" "jazzy" "perky" "zesty" "quirky" "peppy" "spiffy" "nifty" "dandy" "swanky" "cheeky" "plucky" "snappy" "frisky" "giddy" "jolly" "chipper" "dapper")
NOUNS=("penguin" "tiger" "otter" "panda" "koala" "badger" "ferret" "wombat" "platypus" "narwhal" "capybara" "axolotl" "quokka" "lemur" "meerkat" "hedgehog" "sloth" "mongoose" "armadillo" "chinchilla" "ocelot" "tapir")

ADJ_IDX=$((RANDOM % ${#ADJECTIVES[@]}))
NOUN_IDX=$((RANDOM % ${#NOUNS[@]}))

export DEV_INSTANCE_NAME="${ADJECTIVES[$ADJ_IDX]}-${NOUNS[$NOUN_IDX]}"

echo ""
echo "========================================"
echo "  DEV INSTANCE: $DEV_INSTANCE_NAME"
echo "========================================"
echo ""

# Setup QMD (downloads Bun + QMD for current platform if not already present)
echo "Setting up QMD..."
npm run setup-qmd
echo ""

# Kill any existing dev Electron instances (orphaned from previous runs).
# These hold the single instance lock and silently prevent new launches.
# Only kill Electron processes running from node_modules (dev builds),
# NOT from out/ (production builds).
pgrep -f "node_modules/electron/dist/Electron.app" | xargs kill -9 2>/dev/null || true
pkill -9 -f "electron-forge" 2>/dev/null || true

# Dev uses port 9001 to avoid conflicting with production (port 9000)
export DEV_WEBPACK_PORT=9001
lsof -ti:$DEV_WEBPACK_PORT | xargs kill -9 2>/dev/null || true

# Use a separate user data directory for dev so it doesn't touch production data
export GREP_DEV_USER_DATA="/tmp/grep-build-dev"
mkdir -p "$GREP_DEV_USER_DATA"

# Copy from prod ONLY if dev settings don't exist yet.
# Never overwrite — preserves custom models, API keys configured in dev.
# Never symlink — CachedStore flush will corrupt prod settings.
for PROD_DIR in "$HOME/Library/Application Support/Build" "$HOME/Library/Application Support/G-Build" "$HOME/Library/Application Support/Grep Build"; do
  if [ -d "$PROD_DIR" ]; then
    [ ! -f "$GREP_DEV_USER_DATA/claudette-settings.json" ] && [ -f "$PROD_DIR/claudette-settings.json" ] && cp "$PROD_DIR/claudette-settings.json" "$GREP_DEV_USER_DATA/claudette-settings.json"
    [ ! -f "$GREP_DEV_USER_DATA/claudette-mcp-servers.json" ] && [ -f "$PROD_DIR/claudette-mcp-servers.json" ] && cp "$PROD_DIR/claudette-mcp-servers.json" "$GREP_DEV_USER_DATA/claudette-mcp-servers.json"
    [ ! -f "$GREP_DEV_USER_DATA/claudette-sessions.json" ] && [ -f "$PROD_DIR/claudette-sessions.json" ] && cp "$PROD_DIR/claudette-sessions.json" "$GREP_DEV_USER_DATA/claudette-sessions.json" 2>/dev/null
    echo "Synced from $PROD_DIR (settings: $([ -f $GREP_DEV_USER_DATA/claudette-settings.json ] && echo 'kept' || echo 'copied'))"
    break
  fi
done

# Start the dev server with the instance name
npm run start
