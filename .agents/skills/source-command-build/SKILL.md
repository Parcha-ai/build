---
name: "source-command-build"
description: "Migrated source command `build`"
---

# source-command-build

Use this skill when the user asks to run the migrated source command `build`.

## Command Template

# Build Production Application

Build the Grep Build production application for distribution.

## Usage Modes

### Standard Mode: `/build`
Requires QA approval before building. This is the safe, recommended approach.

**Workflow:**
1. Start the dev server (`./scripts/dev.sh`)
2. Wait for user to test and confirm everything works
3. Ask explicitly: "Dev build is running. Please test and confirm when ready to build production."
4. Only proceed with production build after explicit user approval

### Force Mode: `/build force`
Builds immediately without QA check. Use when you're confident the build is ready.

**Workflow:**
1. Bump version in `package.json`
2. **MERGE TO MASTER FIRST** - Push branch and merge to master (see Merge to Master section)
3. Run `npm run make` on master
4. Create git tag
5. Push to both remotes (`origin` and `public`)
6. Open built application

## Build Steps (after QA approval or in force mode)

1. **BUMP THE VERSION** in `package.json` (increment patch version, e.g., 0.0.68 → 0.0.69)
2. **MERGE TO MASTER FIRST** - Push branch and merge to master (see Merge to Master section)
3. **CHECKOUT MASTER** - Switch to master branch after merge
4. Run `npm run make` to create the distributable application
5. **CREATE A RELEASE TAG** with `git tag v{version}`
6. **PUSH TO BOTH REMOTES**:
   ```bash
   git push origin master && git push origin v{version}
   git push public master && git push public v{version}
   ```
7. Open the built application from `out/v{version}/Grep Build-darwin-arm64/Grep Build.app`
8. Report the build status and location of the artifact

## Pre-flight Check (Standard Mode)

Before building, confirm:
- The dev version has been tested and works correctly
- All TypeScript errors have been resolved
- The user has explicitly approved the production build

## CRITICAL: NEVER pkill

**NEVER pkill or kill processes before building!** The user may have other Electron instances running in different worktrees. The build process works fine without killing anything.

## Build Command

```bash
npm run make
```

## Git Remotes

- `origin` → `Parcha-ai/claudette` (private repo)
- `public` → `Parcha-ai/grep-build` (public repo — releases go here)

Always push to BOTH remotes after building.

## Merge to Master

**CRITICAL: Merge BEFORE building!** This ensures the build is created from master.

1. Push the current branch: `git push origin {branch-name}`
2. Check if master is checked out in another worktree: `git worktree list`
3. If master is in another worktree, use GitHub CLI to merge:
   ```bash
   gh pr create --base master --head {branch-name} --title "Release v{version}" --body "Production build v{version}"
   gh pr merge --merge --delete-branch
   ```
4. If master is available locally:
   ```bash
   git checkout master
   git merge {branch-name}
   git push origin master
   ```
5. **After merge, ensure you're on master branch before building:**
   ```bash
   git checkout master
   git pull origin master
   ```

## Post-build

After successful build:
- Create a git tag: `git tag v{version}`
- Push tag and master to both remotes:
  ```bash
  git push origin v{version} && git push public master && git push public v{version}
  ```
- Open the application: `open "out/v{version}/Grep Build-darwin-arm64/Grep Build.app"`
- Report the build artifacts location: `out/v{version}/make/`

## Build Output Structure

Electron Forge outputs to versioned directories:
```
out/v{version}/
├── Grep Build-darwin-arm64/
│   └── Grep Build.app          ← the runnable app
└── make/
    ├── zip/darwin/arm64/
    │   └── Grep Build-darwin-arm64-{version}.zip
    └── Grep Build-{version}-arm64.dmg
```

## Version Bumping

The version is displayed in the bottom right of the app's status bar. Users need to see the new version to confirm they're running the updated build.

To bump the version:
1. Read `package.json`
2. Increment the patch version (last number)
3. Update `package.json` with the new version
4. The new version will be displayed in the built app's status bar
