module.exports = async function runCodexSmoke(args) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (label, fn, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;

    while (Date.now() < deadline) {
      lastValue = await fn();
      if (lastValue) return lastValue;
      await sleep(100);
    }

    throw new Error(`Timed out waiting for ${label}`);
  };

  const getModelButton = () => {
    return [...document.querySelectorAll('button')].find((button) => {
      const title = button.getAttribute('title') || '';
      return title.includes('(click to change)');
    }) || null;
  };

  const testBridge = await waitFor('__GREP_TEST__ bridge', () => window.__GREP_TEST__, 10000);
  const sessionStore = testBridge.useSessionStore;
  const authStore = testBridge.useAuthStore;

  authStore.getState().setDevMode(true);
  await sleep(250);

  await sessionStore.getState().loadSessions();
  await sessionStore.getState().loadAvailableModels();

  let session = sessionStore.getState().sessions.find((candidate) =>
    candidate.isDevMode &&
    candidate.repoPath === args.repoPath
  );

  if (!session) {
    session = await window.electronAPI.dev.createSession({
      name: args.sessionName || 'cdp-smoke',
      repoPath: args.repoPath,
      branch: args.branch || 'master',
      createWorktree: false,
    });
    await sessionStore.getState().loadSessions();
    session = sessionStore.getState().sessions.find((candidate) => candidate.id === session.id) || session;
  }

  await window.electronAPI.sessions.start(session.id);
  await sessionStore.getState().setActiveSession(session.id);
  await sessionStore.getState().loadMessages(session.id);
  await sessionStore.getState().loadAvailableModels();

  const codexModels = sessionStore.getState().availableModels.filter((model) => model.id.startsWith('codex:'));
  const selectedModel = args.model || codexModels[0]?.id || 'codex:gpt-5.6-sol';
  sessionStore.getState().setSelectedModel(session.id, selectedModel);

  await waitFor('model selector button', () => getModelButton(), 10000);
  await sleep(250);

  const modelButton = getModelButton();
  if (!modelButton) {
    throw new Error('Model selector button not found in the renderer');
  }

  const modelButtonText = (modelButton.textContent || '').trim();
  modelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(150);

  const dropdown = modelButton.parentElement?.querySelector('div.absolute');
  const dropdownOptions = dropdown
    ? [...dropdown.querySelectorAll('button')]
        .map((button) => {
          const label = button.querySelector('div')?.textContent || button.textContent || '';
          return label.trim();
        })
        .filter(Boolean)
    : [];

  // Close the dropdown to restore a normal UI state before sending a message.
  modelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(100);

  const messageBaseline = sessionStore.getState().messages[session.id] || [];
  const assistantBaselineCount = messageBaseline.filter((message) => message.role === 'assistant').length;

  const waitForIdle = async () => {
    await waitFor('stream to start', () => sessionStore.getState().isStreaming[session.id], 10000);
    await waitFor('stream to finish', () => !sessionStore.getState().isStreaming[session.id], args.streamTimeoutMs || 90000);
    await sleep(250);
  };

  await sessionStore.getState().sendMessage(session.id, args.prompt || 'Reply with exactly: smoke-ok', []);
  await waitForIdle();

  const messagesAfter = sessionStore.getState().messages[session.id] || [];
  const assistantMessagesAfter = messagesAfter.filter((message) => message.role === 'assistant');
  const newAssistantMessages = assistantMessagesAfter.slice(assistantBaselineCount);
  const assistantContents = newAssistantMessages.map((message) => (message.content || '').trim());
  const hasDuplicateAssistantMessages =
    assistantContents.length > 1 &&
    assistantContents.every((content) => content === assistantContents[0]);

  return {
    sessionId: session.id,
    selectedModel,
    codexModels,
    modelButtonText,
    dropdownOptions,
    newAssistantMessages: assistantContents,
    hasDuplicateAssistantMessages,
  };
};
