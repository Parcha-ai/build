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
  <div className="border border-claude-border bg-claude-surface/50">
    <div
      className={`p-3 flex items-center justify-between ${onToggle ? 'cursor-pointer hover:bg-claude-surface' : ''}`}
      onClick={onToggle}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-bold text-claude-accent px-2 py-0.5 bg-claude-accent/10 border border-claude-accent/30 font-mono">
          v{formatVersion(release.tag_name)}
        </span>
        <span className="text-sm font-bold text-claude-text">{release.name || formatVersion(release.tag_name)}</span>
        <span className="text-xs text-claude-text-secondary font-mono">{formatDate(release.published_at)}</span>
      </div>
      {onToggle && (
        isExpanded ? <ChevronUp size={16} className="text-claude-text-secondary" /> : <ChevronDown size={16} className="text-claude-text-secondary" />
      )}
    </div>

    {isExpanded && release.body && (
      <div className="px-3 pb-3 border-t border-claude-border/50">
        <div className="mt-2 prose prose-invert prose-sm max-w-none
          prose-headings:text-claude-text prose-headings:font-mono prose-headings:uppercase prose-headings:tracking-wider prose-headings:text-xs prose-headings:mt-3 prose-headings:mb-1
          prose-p:text-claude-text-secondary prose-p:text-xs prose-p:leading-relaxed prose-p:my-1
          prose-li:text-claude-text-secondary prose-li:text-xs prose-li:leading-relaxed prose-li:my-0.5
          prose-ul:my-1 prose-ol:my-1
          prose-strong:text-claude-text prose-strong:font-bold
          prose-code:text-purple-400 prose-code:text-[11px] prose-code:bg-purple-500/10 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono
          prose-a:text-claude-accent prose-a:no-underline hover:prose-a:underline
          prose-hr:border-claude-border/30 prose-hr:my-2
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
        <Loader2 size={14} className="animate-spin text-claude-text-secondary" />
        <span className="text-xs font-mono text-claude-text-secondary uppercase tracking-wider">Loading releases...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="py-8 text-center">
        <span className="text-xs font-mono text-red-400 uppercase tracking-wider">{error}</span>
      </div>
    );
  }

  // No releases
  if (releases.length === 0) {
    return (
      <div className="py-8 text-center">
        <span className="text-xs font-mono text-claude-text-secondary uppercase tracking-wider">No releases found</span>
      </div>
    );
  }

  if (banner) {
    const latest = releases[0];
    return (
      <div className="border-b border-claude-border bg-gradient-to-r from-purple-500/5 to-claude-surface/50 p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={14} className="text-purple-400" />
              <span className="text-xs font-bold text-purple-400 uppercase font-mono" style={{ letterSpacing: '0.05em' }}>
                What's New in v{formatVersion(latest.tag_name)}
              </span>
            </div>
            <span className="text-xs text-claude-text-secondary font-mono">
              {latest.name || formatVersion(latest.tag_name)}
            </span>
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="p-1 hover:bg-claude-surface text-claude-text-secondary hover:text-claude-text"
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
      <h3 className="text-sm font-bold text-claude-text uppercase mb-3 font-mono" style={{ letterSpacing: '0.05em' }}>
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
