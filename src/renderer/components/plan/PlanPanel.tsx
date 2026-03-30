import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, FileText, Trash2, Check, XCircle, RefreshCw, ClipboardList, FileCheck } from 'lucide-react';
import { useUIStore } from '../../stores/ui.store';
import { useSessionStore } from '../../stores/session.store';

function SpecMetadataBar({ content }: { content: string }) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const yaml = frontmatterMatch[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  // Match targets under "targets:" — lines starting with "  - "
  const targetsSection = yaml.match(/^targets:\s*\n((?:\s+-\s+.+\n?)*)/m);
  const targets = targetsSection
    ? [...targetsSection[1].matchAll(/^\s*-\s*(.+)$/gm)].map(m => m[1].trim())
    : [];
  const capabilityCount = (content.match(/\[@test\]/g) || []).length;

  return (
    <div className="mb-4 p-3 bg-claude-surface border border-claude-border">
      <div className="flex items-center gap-2 mb-1">
        <FileCheck size={14} className="text-teal-400" />
        <span className="text-xs font-bold uppercase tracking-wider text-teal-400">SPEC</span>
        {name && <span className="text-sm font-mono text-claude-text">{name}</span>}
      </div>
      {description && <p className="text-xs text-claude-text-secondary mb-2">{description}</p>}
      <div className="flex gap-4 text-xs text-claude-text-secondary">
        {targets.length > 0 && <span>{targets.length} target file{targets.length !== 1 ? 's' : ''}</span>}
        {capabilityCount > 0 && <span>{capabilityCount} capabilit{capabilityCount !== 1 ? 'ies' : 'y'}</span>}
      </div>
      {targets.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {targets.map((t, i) => (
            <span key={i} className="px-1.5 py-0.5 text-[10px] font-mono bg-claude-bg border border-claude-border text-claude-text-secondary">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PlanPanel() {
  const { togglePlanPanel, sessionPlanContent, clearPlanContent, setPlanContent } = useUIStore();
  const { activeSessionId, pendingPlanApproval, approvePlan, rejectPlan, messages } = useSessionStore();
  const [feedback, setFeedback] = React.useState('');
  const [showFeedback, setShowFeedback] = React.useState(false);

  const planContent = activeSessionId ? sessionPlanContent[activeSessionId] : null;
  const pendingApproval = activeSessionId ? pendingPlanApproval[activeSessionId] : null;
  const sessionMessages = activeSessionId ? messages[activeSessionId] : [];
  const isSpecFile = !!(planContent?.startsWith('---\n') && planContent?.includes('[@test]'));

  // Debug logging
  React.useEffect(() => {
    console.log('[PlanPanel] Active session:', activeSessionId);
    console.log('[PlanPanel] Plan content exists:', !!planContent);
    console.log('[PlanPanel] Plan content length:', planContent?.length);
    console.log('[PlanPanel] Pending approval:', !!pendingApproval);
    console.log('[PlanPanel] All session plan content keys:', Object.keys(sessionPlanContent));
  }, [activeSessionId, planContent, pendingApproval, sessionPlanContent]);

  // Reset feedback when plan approval changes
  React.useEffect(() => {
    if (!pendingApproval) {
      setFeedback('');
      setShowFeedback(false);
    }
  }, [pendingApproval]);

  // Auto-load plan from messages if no plan content exists
  React.useEffect(() => {
    if (!activeSessionId || !sessionMessages || sessionMessages.length === 0) return;
    if (planContent) return; // Already have plan content

    console.log('[PlanPanel] No plan content, auto-loading from messages...');
    handleLoadFromMessages();
  }, [activeSessionId, sessionMessages]); // Run when session or messages change

  const handleClear = () => {
    if (activeSessionId) {
      clearPlanContent(activeSessionId);
    }
  };

  const handleApprove = async () => {
    if (activeSessionId) {
      await approvePlan(activeSessionId);
      setFeedback('');
      setShowFeedback(false);
    }
  };

  const handleReject = async () => {
    if (activeSessionId) {
      const feedbackToSend = feedback.trim() || undefined;
      await rejectPlan(activeSessionId, feedbackToSend);
      setFeedback('');
      setShowFeedback(false);
    }
  };

  const handleRejectWithFeedback = () => {
    setShowFeedback(true);
  };

  const handleLoadFromMessages = () => {
    console.log('[PlanPanel] Load button clicked');
    console.log('[PlanPanel] Active session:', activeSessionId);
    console.log('[PlanPanel] Messages available:', sessionMessages?.length);

    if (!activeSessionId) {
      console.error('[PlanPanel] No active session ID');
      return;
    }

    if (!sessionMessages || sessionMessages.length === 0) {
      console.error('[PlanPanel] No messages in session');
      return;
    }

    console.log('[PlanPanel] Scanning messages...');

    // FIRST: Check tool calls for Write operations to plan files
    // This is the most reliable source as it contains the actual plan file content
    console.log('[PlanPanel] Priority 1: Checking Write tool calls for plan files...');
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const msg = sessionMessages[i];
      console.log(`[PlanPanel] Message ${i} has ${msg.toolCalls?.length || 0} tool calls`);
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (let j = 0; j < msg.toolCalls.length; j++) {
          const toolCall = msg.toolCalls[j];
          console.log(`[PlanPanel] Tool call ${j}: name="${toolCall.name}", has input=${!!toolCall.input}, has result=${!!toolCall.result}`);

          if (toolCall.name === 'Write') {
            console.log(`[PlanPanel] Write tool input:`, JSON.stringify(toolCall.input).substring(0, 200));

            if (toolCall.input?.file_path) {
              const filePath = toolCall.input.file_path as string;
              console.log(`[PlanPanel] Write tool file path: ${filePath}`);

              const isSpecFile = filePath.endsWith('.spec.md');
              if ((filePath.includes('.claude/plans') && filePath.endsWith('.md')) || isSpecFile) {
                const content = toolCall.input.content as string;
                console.log(`[PlanPanel] Found ${isSpecFile ? 'spec' : 'plan'} file Write, content length: ${content?.length || 0}, first 100 chars:`, content?.substring(0, 100));

                if (content && content.length > (isSpecFile ? 200 : 500)) {
                  console.log('[PlanPanel] ✅ Loading plan from Write tool call:', filePath);
                  setPlanContent(activeSessionId, content);
                  return;
                }
              }
            }
          }
        }
      }
    }

    // SECOND: Check direct messages for plan content (fallback)
    // Only match substantial markdown documents, not short summaries
    // This should RARELY match - most plans are in Write tool calls
    console.log('[PlanPanel] Priority 2: Checking direct messages...');
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const msg = sessionMessages[i];
      console.log(`[PlanPanel] Message ${i}: role=${msg.role}, content length=${msg.content?.length || 0}`);

      if (msg.role === 'assistant' && msg.content) {
        const content = msg.content.trim();

        // VERY strict requirements - must be a full plan document
        const isVerySubstantial = content.length > 5000; // 5K+ chars only
        const hasHeaders = content.includes('# ') || content.includes('## ') || content.includes('### ');
        const hasMultipleSections = (content.match(/\n#{1,3} /g) || []).length >= 5; // At least 5 sections
        const looksLikePlan = content.includes('## ') && (
          content.includes('Implementation') ||
          content.includes('Architecture') ||
          content.includes('Approach') ||
          content.includes('Solution')
        );

        console.log(`[PlanPanel] Message ${i} checks: length=${content.length}, hasHeaders=${hasHeaders}, hasMultipleSections=${hasMultipleSections}, looksLikePlan=${looksLikePlan}`);

        if (isVerySubstantial && hasHeaders && hasMultipleSections && looksLikePlan) {
          console.log('[PlanPanel] ✅ Loading plan from message:', msg.id, 'length:', content.length);
          setPlanContent(activeSessionId, content);
          return;
        }
      }
    }

    console.warn('[PlanPanel] ❌ No plan found in messages or tool calls');
  };

  return (
    <div className="h-full flex flex-col bg-claude-bg">
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-claude-border bg-claude-surface">
        <div className="flex items-center gap-2">
          {isSpecFile ? <FileCheck size={14} className="text-teal-400" /> : <ClipboardList size={14} className="text-claude-accent" />}
          <span className="text-sm font-medium">{isSpecFile ? 'Spec' : 'Plan'}</span>
          {isSpecFile && (
            <span className="px-2 py-0.5 text-xs font-medium bg-teal-500/20 text-teal-400 border border-teal-500/30">
              SDD
            </span>
          )}
          {pendingApproval && (
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30">
              Awaiting Approval
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {planContent && !pendingApproval && sessionMessages && sessionMessages.length > 0 && (
            <button
              onClick={handleLoadFromMessages}
              className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
              title="Reload plan from messages"
            >
              <RefreshCw size={14} />
            </button>
          )}
          {planContent && !pendingApproval && (
            <button
              onClick={handleClear}
              className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
              title="Clear plan"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={togglePlanPanel}
            className="p-1 rounded hover:bg-claude-bg text-claude-text-secondary hover:text-claude-text"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Approval buttons - shown when there's a pending approval */}
      {pendingApproval && (
        <div className="px-4 py-3 border-b border-claude-border bg-claude-surface/50">
          <p className="text-sm text-claude-text-secondary mb-3">
            Claude has created a plan and is waiting for your approval to proceed.
          </p>

          {!showFeedback ? (
            <div className="flex gap-2">
              <button
                onClick={handleApprove}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white font-medium text-sm transition-colors"
              >
                <Check size={16} />
                Approve Plan
              </button>
              <button
                onClick={handleRejectWithFeedback}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-claude-surface hover:bg-claude-bg border border-claude-border text-claude-text font-medium text-sm transition-colors"
              >
                <RefreshCw size={16} />
                Request Updates
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Describe what changes you'd like to see in the plan..."
                className="w-full h-24 px-3 py-2 text-sm bg-claude-bg border border-claude-border text-claude-text placeholder-claude-text-secondary resize-none focus:outline-none focus:border-claude-accent font-mono"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleReject}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium text-sm transition-colors"
                >
                  <RefreshCw size={16} />
                  Update Plan
                </button>
                <button
                  onClick={() => setShowFeedback(false)}
                  className="px-4 py-2 bg-claude-surface hover:bg-claude-bg border border-claude-border text-claude-text font-medium text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pendingApproval.allowedPrompts && pendingApproval.allowedPrompts.length > 0 && !showFeedback && (
            <div className="mt-3 pt-3 border-t border-claude-border">
              <p className="text-xs text-claude-text-secondary mb-2">Requested permissions:</p>
              <ul className="text-xs text-claude-text-secondary space-y-1">
                {pendingApproval.allowedPrompts.map((prompt, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="text-claude-accent">•</span>
                    {prompt.prompt}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!planContent && sessionMessages && sessionMessages.length > 0 && (
          <div className="h-full flex flex-col items-center justify-center text-claude-text-secondary p-4">
            <FileText size={32} className="mb-3 opacity-50" />
            <p className="text-sm font-mono mb-4 text-center">No plan loaded</p>
            <button
              onClick={handleLoadFromMessages}
              className="px-4 py-2 bg-claude-accent hover:bg-claude-accent/80 text-white font-medium text-sm transition-colors"
            >
              Load Plan from Messages
            </button>
            <p className="text-xs font-mono mt-2 opacity-70 text-center max-w-xs">
              If you created a plan in this session, click to load it
            </p>
          </div>
        )}
        {planContent ? (
          <div className="prose prose-invert prose-sm max-w-none font-mono">
            {isSpecFile && <SpecMetadataBar content={planContent} />}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Custom styling for plan content
                h1: ({ children }) => (
                  <h1 className="text-lg font-bold text-claude-text border-b border-claude-border pb-2 mb-4">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-base font-bold text-claude-text mt-6 mb-2">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-sm font-bold text-claude-text mt-4 mb-2">
                    {children}
                  </h3>
                ),
                p: ({ children }) => (
                  <p className="text-sm text-claude-text-secondary leading-relaxed my-2">
                    {children}
                  </p>
                ),
                ul: ({ children }) => (
                  <ul className="list-disc list-outside ml-4 my-2 space-y-1">
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal list-outside ml-4 my-2 space-y-1">
                    {children}
                  </ol>
                ),
                li: ({ children }) => (
                  <li className="text-sm text-claude-text-secondary">
                    {children}
                  </li>
                ),
                code: ({ className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || '');
                  const isBlock = String(children).includes('\n') || match;
                  if (isBlock) {
                    return (
                      <div className="overflow-hidden border border-claude-border my-2" style={{ borderRadius: 0 }}>
                        {match && (
                          <div className="px-2 py-1 text-xs font-bold font-mono bg-claude-surface border-b border-claude-border text-claude-text-secondary uppercase tracking-wider">
                            {match[1]}
                          </div>
                        )}
                        <pre className="p-3 bg-claude-bg m-0 overflow-x-auto">
                          <code className="text-xs font-mono text-claude-text" {...props}>
                            {children}
                          </code>
                        </pre>
                      </div>
                    );
                  }
                  return (
                    <code
                      className="px-1 py-0.5 text-xs font-mono bg-claude-surface text-claude-accent"
                      style={{ borderRadius: 0 }}
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-claude-accent pl-3 my-2 text-claude-text-secondary italic">
                    {children}
                  </blockquote>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2">
                    <table className="w-full text-sm border-collapse border border-claude-border">
                      {children}
                    </table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border border-claude-border bg-claude-surface px-2 py-1 text-left font-bold text-claude-text">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="border border-claude-border px-2 py-1 text-claude-text-secondary">
                    {children}
                  </td>
                ),
                hr: () => <hr className="border-claude-border my-4" />,
                a: ({ href, children }) => {
                  const childText = String(children);
                  if (childText === '@test' && href) {
                    return (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-bold bg-teal-500/20 text-teal-400 border border-teal-500/30 cursor-default"
                        title={`Test: ${href}`}
                      >
                        @test
                      </span>
                    );
                  }
                  return (
                    <a
                      href={href}
                      className="text-claude-accent hover:underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {children}
                    </a>
                  );
                },
                // Task list support
                input: ({ type, checked, ...props }) => {
                  if (type === 'checkbox') {
                    return (
                      <input
                        type="checkbox"
                        checked={checked}
                        readOnly
                        className="mr-2 accent-claude-accent"
                        {...props}
                      />
                    );
                  }
                  return <input type={type} {...props} />;
                },
              }}
            >
              {planContent}
            </ReactMarkdown>
          </div>
        ) : (!sessionMessages || sessionMessages.length === 0) && (
          <div className="h-full flex flex-col items-center justify-center text-claude-text-secondary">
            <FileText size={32} className="mb-3 opacity-50" />
            <p className="text-sm font-mono">No plan created yet</p>
            <p className="text-xs font-mono mt-1 opacity-70">
              Switch to Plan mode to generate a plan
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
