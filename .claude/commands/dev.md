# Start Development Server

Start the Grep Build development server for testing changes.

## CRITICAL: Kill existing instances first

ALWAYS kill ALL existing dev Electron instances before starting. The single instance lock prevents a second instance from launching.

```bash
pkill -9 -f "Electron.*node_modules" 2>/dev/null
pkill -9 -f "electron-forge" 2>/dev/null
lsof -ti :9000 | xargs kill -9 2>/dev/null
sleep 2
```

## Sync production data to dev

Copy sessions, settings, and MCP servers so dev has the same state as production:

```bash
cp "/Users/aj/Library/Application Support/G-Build/claudette-sessions.json" /tmp/grep-build-dev/
cp "/Users/aj/Library/Application Support/G-Build/claudette-settings.json" /tmp/grep-build-dev/
cp "/Users/aj/Library/Application Support/G-Build/claudette-mcp-servers.json" /tmp/grep-build-dev/
```

## Start dev server

```bash
./scripts/dev.sh
```

The script will:
1. Generate a unique dev instance name (e.g., `snappy-koala`)
2. Print it prominently to the terminal
3. Set up QMD and sync settings
4. Start the dev server

## Important

- Hot reload works for RENDERER only (React components, stores, styles)
- Main process changes (services, IPC handlers, preload) require a FULL RESTART
- Always kill + restart when modifying main process files
- The instance name appears in the bottom-right status bar

## CRITICAL: Always report the instance name

After running `./scripts/dev.sh`, always tell the user the instance name, e.g.:

> Dev build **snappy-koala** is now running.
