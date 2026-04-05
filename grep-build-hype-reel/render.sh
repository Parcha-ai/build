#!/bin/bash
set -e

echo "=== Grep Build Hype Reel Renderer ==="

# High quality MP4 (H.264)
echo "Rendering MP4 (high quality)..."
npx remotion render src/index.ts HypeReel out/grep-build-hype.mp4 --crf 15 --pixel-format yuv444p

# ProRes (lossless, for editing)
echo "Rendering ProRes..."
npx remotion render src/index.ts HypeReel out/grep-build-hype.mov --codec prores --prores-profile 4444

echo "=== Done ==="
echo "Output files:"
ls -lh out/grep-build-hype.*
