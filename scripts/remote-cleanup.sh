#!/bin/bash
# Remote nightly cleanup — kills leaked MCP servers, stale Chrome/Puppeteer
# processes, zombie Claude processes, and purges temp directories.
# Installed as a cron job running at 2:00 AM Pacific (9:00 AM UTC).

LOG="/var/log/grep-build-cleanup.log"
exec >> "$LOG" 2>&1

echo "=========================================="
echo "Cleanup run: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=========================================="

echo "--- Before ---"
free -h | head -3
uptime

FREED=0

# 1. Kill leaked chrome-devtools-mcp processes
MCP_COUNT="$(pgrep -c -f chrome-devtools-mcp 2>/dev/null)" || MCP_COUNT=0
if [ "$MCP_COUNT" -gt 0 ]; then
  MCP_RSS=$(ps -C chrome-devtools-mcp -o rss= 2>/dev/null | awk '{s+=$1}END{printf "%.0f", s/1024}')
  pkill -9 -f chrome-devtools-mcp 2>/dev/null || true
  echo "Killed $MCP_COUNT chrome-devtools-mcp processes (~${MCP_RSS}MB)"
  FREED=$((FREED + MCP_RSS))
else
  echo "No chrome-devtools-mcp processes found"
fi

# 2. Kill stale Puppeteer Chrome processes (headless browsers from old sessions)
CHROME_COUNT="$(pgrep -c -f 'puppeteer_dev_chrome_profile' 2>/dev/null)" || CHROME_COUNT=0
if [ "$CHROME_COUNT" -gt 0 ]; then
  CHROME_RSS=$(pgrep -f 'puppeteer_dev_chrome_profile' | xargs -I{} ps -o rss= -p {} 2>/dev/null | awk '{s+=$1}END{printf "%.0f", s/1024}')
  pkill -9 -f 'puppeteer_dev_chrome_profile' 2>/dev/null || true
  echo "Killed $CHROME_COUNT puppeteer Chrome processes (~${CHROME_RSS}MB)"
  FREED=$((FREED + CHROME_RSS))
else
  echo "No stale puppeteer Chrome processes found"
fi

# 3. Kill any remaining orphan /opt/google/chrome processes not attached to a session
ORPHAN_CHROME="$(pgrep -c -f '/opt/google/chrome/chrome' 2>/dev/null)" || ORPHAN_CHROME=0
if [ "$ORPHAN_CHROME" -gt 0 ]; then
  ORPHAN_RSS=$(pgrep -f '/opt/google/chrome/chrome' | xargs -I{} ps -o rss= -p {} 2>/dev/null | awk '{s+=$1}END{printf "%.0f", s/1024}')
  pkill -9 -f '/opt/google/chrome/chrome' 2>/dev/null || true
  echo "Killed $ORPHAN_CHROME orphan Chrome processes (~${ORPHAN_RSS}MB)"
  FREED=$((FREED + ORPHAN_RSS))
else
  echo "No orphan Chrome processes found"
fi

# 4. Clean up zombie (defunct) Claude processes
ZOMBIE_COUNT="$(ps aux | grep '\[claude\] <defunct>' | grep -vc grep)" || ZOMBIE_COUNT=0
if [ "$ZOMBIE_COUNT" -gt 0 ]; then
  ps aux | grep '\[claude\] <defunct>' | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
  echo "Cleaned $ZOMBIE_COUNT zombie Claude processes"
else
  echo "No zombie Claude processes found"
fi

# 5. Purge stale puppeteer temp directories
TEMP_COUNT="$(find /tmp -maxdepth 1 -name 'puppeteer_dev_chrome_profile-*' -type d 2>/dev/null | wc -l)" || TEMP_COUNT=0
if [ "$TEMP_COUNT" -gt 0 ]; then
  rm -rf /tmp/puppeteer_dev_chrome_profile-* 2>/dev/null || true
  echo "Removed $TEMP_COUNT puppeteer temp directories"
else
  echo "No puppeteer temp directories found"
fi

# 6. Purge old Claude Code temp files (>7 days)
OLD_CLAUDE_TEMPS="$(find /tmp -maxdepth 1 -name 'claude-*' -mtime +7 2>/dev/null | wc -l)" || OLD_CLAUDE_TEMPS=0
if [ "$OLD_CLAUDE_TEMPS" -gt 0 ]; then
  find /tmp -maxdepth 1 -name 'claude-*' -mtime +7 -exec rm -rf {} + 2>/dev/null || true
  echo "Removed $OLD_CLAUDE_TEMPS old Claude temp files"
fi

sleep 2

echo "--- After ---"
free -h | head -3
uptime
echo "Estimated memory freed: ~${FREED}MB"
echo "Cleanup complete."
echo ""
