import React, { useState } from 'react';
import { useAuthStore } from '../../stores/auth.store';
import { useSessionStore } from '../../stores/session.store';
import { Github, Loader2, FolderOpen, GitBranch, AlertCircle } from 'lucide-react';

interface PendingFolder {
  repoPath: string;
  name: string;
}

export default function LoginScreen() {
  const { login, isLoading, error, setDevMode } = useAuthStore();
  const { setActiveSession, addSession } = useSessionStore();
  const [devError, setDevError] = useState<string | null>(null);
  const [isOpeningRepo, setIsOpeningRepo] = useState(false);
  const [isInitializingGit, setIsInitializingGit] = useState(false);
  const [pendingFolder, setPendingFolder] = useState<PendingFolder | null>(null);

  const handleOpenLocalRepo = async () => {
    setIsOpeningRepo(true);
    setDevError(null);
    setPendingFolder(null);

    try {
      const result = await window.electronAPI.dev.openLocalRepo();

      if (result.canceled) {
        setIsOpeningRepo(false);
        return;
      }

      if (!result.success) {
        setDevError(result.error || 'Failed to open folder');
        setIsOpeningRepo(false);
        return;
      }

      // Check if git init is needed
      if (result.needsGitInit) {
        setPendingFolder({
          repoPath: result.repoPath!,
          name: result.name!,
        });
        setIsOpeningRepo(false);
        return;
      }

      // Create a dev session
      await createAndActivateSession(result.name!, result.repoPath!, result.branch!);
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Failed to open folder');
    } finally {
      setIsOpeningRepo(false);
    }
  };

  const handleInitGit = async () => {
    if (!pendingFolder) return;

    setIsInitializingGit(true);
    setDevError(null);

    try {
      const result = await window.electronAPI.dev.initGit(pendingFolder.repoPath);

      if (!result.success) {
        setDevError(result.error || 'Failed to initialize git repository');
        setIsInitializingGit(false);
        return;
      }

      // Create a dev session with the new repo
      await createAndActivateSession(
        pendingFolder.name,
        pendingFolder.repoPath,
        result.branch || 'main'
      );

      setPendingFolder(null);
    } catch (err) {
      setDevError(err instanceof Error ? err.message : 'Failed to initialize git');
    } finally {
      setIsInitializingGit(false);
    }
  };

  const handleSkipGit = async () => {
    if (!pendingFolder) return;

    // Create session without git
    await createAndActivateSession(
      pendingFolder.name,
      pendingFolder.repoPath,
      'no-git' // Marker for no git
    );

    setPendingFolder(null);
  };

  const createAndActivateSession = async (name: string, repoPath: string, branch: string) => {
    const session = await window.electronAPI.dev.createSession({
      name,
      repoPath,
      branch,
    });

    addSession(session);
    setActiveSession(session.id);
    setDevMode(true);
  };

  // Show git init confirmation dialog - brutalist
  if (pendingFolder) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-claude-bg">
        <div className="w-full max-w-md p-6">
          <div
            className="p-5 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]"
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 flex items-center justify-center bg-amber/15"
                style={{ borderRadius: 0 }}
              >
                <AlertCircle size={20} className="text-amber" />
              </div>
              <div>
                <h2 className="text-[16px] font-semibold tracking-tight text-fg">
                  NOT A GIT REPOSITORY
                </h2>
                <p className="font-mono text-[11.5px] text-fg-4">
                  {pendingFolder.name}
                </p>
              </div>
            </div>

            <p className="text-[13px] leading-relaxed mb-5 text-fg-3">
              This folder is not a git repository. Would you like to initialize one?
              Git enables version control and allows Claude to better understand your project history.
            </p>

            {devError && (
              <div
                className="mb-4 p-2.5 text-[12.5px] bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] text-diff-del-text"
                style={{ borderRadius: 0 }}
              >
                {devError}
              </div>
            )}

            <div className="space-y-2">
              <button
                onClick={handleInitGit}
                disabled={isInitializingGit}
                className="w-full h-9 px-4 text-ink-0 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40 bg-fg hover:bg-white"
              >
                {isInitializingGit ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <GitBranch size={14} />
                )}
                {isInitializingGit ? 'INITIALIZING...' : 'INITIALIZE GIT'}
              </button>

              <button
                onClick={handleSkipGit}
                disabled={isInitializingGit}
                className="w-full h-9 px-4 text-[13px] flex items-center justify-center gap-2 disabled:opacity-40 text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
              >
                <FolderOpen size={14} />
                OPEN WITHOUT GIT
              </button>

              <button
                onClick={() => setPendingFolder(null)}
                disabled={isInitializingGit}
                className="w-full h-8 px-4 text-[13px] text-fg-3 hover:text-fg hover:bg-claude-surface-hover"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-claude-bg">
      <div className="w-full max-w-md p-6">
        {/* Logo - brutalist */}
        <div className="text-center mb-6">
          {/* Build blocky G lettermark logo */}
          <div className="flex justify-center mb-4">
            <div className="w-24 h-24 bg-fg flex items-center justify-center p-3">
              <svg viewBox="0 0 923 923" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M312.676 121V217.652H217V708.35H312.676V803.94H609.165V708.35H705.893V422.065H411.621V576.314H519.083V515.971H598.651V697.729H323.189V228.273H598.651V321.233H705.893V217.652H609.165V121H312.676Z" fill="#000000"/>
              </svg>
            </div>
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight mb-1 text-fg">
            GREP BUILD
          </h1>
          <p className="text-[11px] uppercase tracking-[0.04em] text-fg-4">
            AI-POWERED DEVELOPMENT ENVIRONMENT
          </p>
        </div>

        {/* Login card - brutalist */}
        <div
          className="p-5 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_16px_40px_rgba(0,0,0,0.4)]"
          style={{ borderRadius: 0 }}
        >
          <h2 className="text-[11px] font-medium uppercase tracking-[0.04em] mb-4 text-center text-fg-4">
            SIGN IN TO CONTINUE
          </h2>

          {(error || devError) && (
            <div
              className="mb-4 p-2.5 text-[12.5px] bg-diff-del/10 shadow-[inset_0_0_0_1px_rgba(248,81,73,0.45)] text-diff-del-text"
              style={{ borderRadius: 0 }}
            >
              {error || devError}
            </div>
          )}

          <button
            onClick={login}
            disabled={isLoading || isOpeningRepo}
            className="w-full h-9 px-4 text-[13px] font-semibold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-fg text-ink-0 hover:bg-white"
          >
            {isLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Github size={14} />
            )}
            {isLoading ? 'CONNECTING...' : 'GITHUB LOGIN'}
          </button>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-line" />
            </div>
            <div className="relative flex justify-center text-[11px] tracking-[0.04em]">
              <span className="px-2 bg-ink-2 text-fg-4">OR</span>
            </div>
          </div>

          <button
            onClick={handleOpenLocalRepo}
            disabled={isLoading || isOpeningRepo}
            className="w-full h-9 px-4 text-[13px] flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed text-fg-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:bg-claude-surface-hover"
          >
            {isOpeningRepo ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            {isOpeningRepo ? 'OPENING...' : 'LOCAL FOLDER'}
          </button>

          <p className="mt-4 text-[12px] text-center text-fg-4">
            Dev Mode: Open any local folder to get started.
            <br />
            Git repository optional.
          </p>
        </div>

        {/* Features - brutalist */}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Feature title="MULTI-SESSION" description="Parallel dev environments" />
          <Feature title="AI ASSISTANT" description="Code, debug, refactor" />
          <Feature title="LIVE PREVIEW" description="Instant browser updates" />
          <Feature title="GIT INTEGRATION" description="Visual history & branches" />
        </div>
      </div>
    </div>
  );
}

function Feature({ title, description }: { title: string; description: string }) {
  return (
    <div
      className="p-2.5 bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
    >
      <h3 className="text-[11px] font-medium uppercase tracking-[0.04em] mb-0.5 text-fg-2">
        {title}
      </h3>
      <p className="text-[12px] text-fg-4">
        {description}
      </p>
    </div>
  );
}
