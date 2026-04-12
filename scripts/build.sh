#!/bin/bash
# Build script for Build
# Usage: ./scripts/build.sh

set -e

echo "🔨 Building Build..."

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "📦 Version: v${VERSION}"

# Kill any running instances of Build
echo "🛑 Stopping any running Build instances..."
pkill -f "Build.app" 2>/dev/null || true
sleep 1

# Kill any dev server processes
pkill -f "electron-forge" 2>/dev/null || true
pkill -f "Electron" 2>/dev/null || true
sleep 1

# Run the build
echo "🏗️  Running electron-forge make..."
npm run make

# Create git tag
echo "🏷️  Creating git tag v${VERSION}..."
git tag -f "v${VERSION}" 2>/dev/null || true

# Open the built app
APP_PATH="./out/v${VERSION}/Build-darwin-arm64/Build.app"
if [ -d "$APP_PATH" ]; then
    echo "🚀 Launching Build v${VERSION}..."
    open "$APP_PATH"
else
    echo "❌ Build output not found at: $APP_PATH"
    exit 1
fi

echo "✅ Build complete! Build v${VERSION} is now running."
