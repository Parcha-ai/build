import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, Sparkles, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  html_url: string;
}

interface ReleaseNotesProps {
  /** Show only the latest release in compact form */
  compact?: boolean;
  /** Show as dismissible banner */
  banner?: boolean;
  /** Callback when banner is dismissed */
  onDismiss?: () => void;
}

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Parcha-ai/build/releases?per_page=20';

function formatVersion(tagName: string): string {
  return tagName.replace(/^v/, '');
}

function formatDate(isoDate: string): string {
  return isoDate.slice(0, 10); // YYYY-MM-DD
}

const ReleaseCard = ({ release, isExpanded, onToggle }: {
  release: GitHubRelease;
  isExpanded: boolean;
  onToggle?: () => void;
}) => (
  <div className="bg-ink-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]">
    <div
      className={`p-3 flex items-center justify-between ${onToggle ? 'cursor-pointer hover:bg-claude-surface-hover' : ''}`}
      onClick={onToggle}
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] font-medium text-accent-text px-1.5 py-0.5 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(76,154,255,0.35)]">
          v{formatVersion(release.tag_name)}
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-fg">{release.name || formatVersion(release.tag_name)}</span>
        <span className="font-mono text-[11px] text-fg-4">{formatDate(release.published_at)}</span>
      </div>
      {onToggle && (
        isExpanded ? <ChevronUp size={16} className="text-fg-4" /> : <ChevronDown size={16} className="text-fg-4" />
      )}
    </div>

    {isExpanded && release.body && (
      <div className="px-3 pb-3 border-t border-line">
        <div className="mt-2 prose prose-invert prose-sm max-w-none
          prose-headings:text-fg prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-[13px] prose-headings:mt-3 prose-headings:mb-1
          prose-p:text-fg-3 prose-p:text-[13px] prose-p:leading-relaxed prose-p:my-1
          prose-li:text-fg-3 prose-li:text-[13px] prose-li:leading-relaxed prose-li:my-0.5
          prose-ul:my-1 prose-ol:my-1
          prose-strong:text-fg prose-strong:font-semibold
          prose-code:text-fg-2 prose-code:text-[11.5px] prose-code:bg-ink-4 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono
          prose-a:text-accent-text prose-a:no-underline hover:prose-a:underline
          prose-hr:border-line prose-hr:my-2
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{release.body}</ReactMarkdown>
        </div>
      </div>
    )}
  </div>
);

export default function ReleaseNotes({ compact = false, banner = false, onDismiss }: ReleaseNotesProps) {
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetch(GITHUB_RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
    })
      .then(res => {
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        return res.json();
      })
      .then((data: GitHubRelease[]) => {
        if (cancelled) return;
        setReleases(data);
        // Auto-expand the latest release
        if (data.length > 0) {
          setExpandedVersions(new Set([data[0].tag_name]));
        }
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[ReleaseNotes] Failed to fetch releases:', err);
        setError('Failed to load releases');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const toggleExpanded = (tagName: string) => {
    setExpandedVersions(prev => {
      const next = new Set(prev);
      if (next.has(tagName)) {
        next.delete(tagName);
      } else {
        next.add(tagName);
      }
      return next;
    });
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <Loader2 size={14} className="animate-spin text-fg-4" />
        <span className="text-[13px] text-fg-3">Loading releases...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="py-8 text-center">
        <span className="text-[13px] text-diff-del">{error}</span>
      </div>
    );
  }

  // No releases
  if (releases.length === 0) {
    return (
      <div className="py-8 text-center">
        <span className="text-[13px] text-fg-3">No releases found</span>
      </div>
    );
  }

  if (banner) {
    const latest = releases[0];
    return (
      <div className="border-b border-line bg-ink-1 p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={14} className="text-accent" />
              <span className="text-[13px] font-semibold tracking-tight text-fg">
                What's New in v{formatVersion(latest.tag_name)}
              </span>
            </div>
            <span className="text-[12px] text-fg-3">
              {latest.name || formatVersion(latest.tag_name)}
            </span>
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="p-1 hover:bg-claude-surface-hover text-fg-3 hover:text-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  if (compact) {
    const latest = releases[0];
    return (
      <div className="space-y-2">
        <ReleaseCard
          release={latest}
          isExpanded={true}
          onToggle={undefined}
        />
      </div>
    );
  }

  // Full release notes list
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.04em] text-fg-4 mb-3">
        Release History
      </h3>
      {releases.map(release => (
        <ReleaseCard
          key={release.tag_name}
          release={release}
          isExpanded={expandedVersions.has(release.tag_name)}
          onToggle={() => toggleExpanded(release.tag_name)}
        />
      ))}
    </div>
  );
}
