import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { ArcBrowserProfile, ArcCookieImportResult } from '../../../shared/types';

interface ArcImportMenuProps {
  partitionId: string;
  onImported: () => void;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

const MENU_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .replace(/^Error:\s*/, '');
}

export default function ArcImportMenu({ partitionId, onImported }: ArcImportMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [profiles, setProfiles] = useState<ArcBrowserProfile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingProfileId, setImportingProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArcCookieImportResult | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfiles(await window.electronAPI.browser.listArcProfiles());
    } catch (loadError) {
      setProfiles([]);
      setError(readableError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - (VIEWPORT_MARGIN * 2));
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - width),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    setMenuPosition({ top: rect.bottom + VIEWPORT_MARGIN, left, width });
  }, []);

  const toggleMenu = () => {
    const nextOpen = !open;
    if (nextOpen) updateMenuPosition();
    setOpen(nextOpen);
    if (nextOpen && profiles === null && !loading) void loadProfiles();
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const reposition = () => updateMenuPosition();
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, updateMenuPosition]);

  const importProfile = async (profile: ArcBrowserProfile) => {
    setImportingProfileId(profile.id);
    setError(null);
    setResult(null);
    try {
      const importResult = await window.electronAPI.browser.importArcCookies(partitionId, profile.id);
      setResult(importResult);
      onImported();
    } catch (importError) {
      setError(readableError(importError));
    } finally {
      setImportingProfileId(null);
    }
  };

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        className={`w-7 h-7 flex items-center justify-center transition-colors ${open ? 'bg-[rgba(76,154,255,0.13)] text-accent-text' : 'text-fg-4 hover:text-fg hover:bg-claude-surface-hover'}`}
        title="Import cookies and signed-in sessions from Arc"
        aria-label="Import cookies and signed-in sessions from Arc"
        aria-expanded={open}
      >
        <Download size={16} />
      </button>

      {open && menuPosition && createPortal(
        <div
          ref={popoverRef}
          data-testid="arc-import-menu"
          className="fixed z-[10000] overflow-hidden bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1),0_12px_40px_rgba(0,0,0,0.45)]"
          style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-3 py-2.5">
            <div>
              <div className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Import from Arc</div>
              <div className="mt-0.5 text-[11.5px] leading-4 text-fg-4">
                Copies cookies and sign-ins into this Build browser profile. Arc stays unchanged.
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadProfiles()}
              disabled={loading || importingProfileId !== null}
              className="p-1 text-fg-4 hover:bg-claude-surface-hover hover:text-fg disabled:opacity-40"
              title="Refresh Arc profiles"
              aria-label="Refresh Arc profiles"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto p-2">
            {loading && profiles === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-fg-4">
                <Loader2 size={14} className="animate-spin" />
                Finding Arc profiles…
              </div>
            ) : profiles && profiles.length > 0 ? (
              <div className="space-y-1.5">
                {profiles.map((profile) => {
                  const importing = importingProfileId === profile.id;
                  return (
                    <div
                      key={profile.id}
                      className="flex items-center gap-3 bg-ink-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-fg">
                          {profile.name}
                          {profile.isDefault && (
                            <span className="ml-1.5 font-mono text-[9.5px] uppercase text-fg-3 px-1 py-px shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]">Default</span>
                          )}
                        </div>
                        <div className="font-mono text-[11px] text-fg-4">
                          {profile.cookieCount.toLocaleString()} cookies
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void importProfile(profile)}
                        disabled={importingProfileId !== null}
                        className="flex items-center gap-1 h-7 bg-[#EDEDED] px-2.5 text-[12px] font-semibold text-[#0F0F0F] hover:bg-white disabled:opacity-50"
                      >
                        {importing && <Loader2 size={11} className="animate-spin" />}
                        {importing ? 'Importing' : 'Import'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : !error ? (
              <div className="py-6 text-center text-[12px] text-fg-4">No Arc profiles found.</div>
            ) : null}

            {result && (
              <div className="mt-2 flex gap-2 bg-[rgba(63,185,80,0.09)] shadow-[inset_0_0_0_1px_rgba(63,185,80,0.3)] px-2.5 py-2 text-[11.5px] leading-4 text-diff-add-text">
                <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  Imported {result.imported.toLocaleString()} cookies from {result.profileName}.
                  {result.skipped > 0 ? ` ${result.skipped.toLocaleString()} incompatible or expired cookies were skipped.` : ''}
                  {result.failed > 0 ? ` ${result.failed.toLocaleString()} could not be written.` : ''}
                </span>
              </div>
            )}

            {error && (
              <div className="mt-2 flex gap-2 bg-[rgba(248,81,73,0.09)] shadow-[inset_0_0_0_1px_rgba(248,81,73,0.3)] px-2.5 py-2 text-[11.5px] leading-4 text-diff-del-text">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
