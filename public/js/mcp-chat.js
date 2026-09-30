'use strict';
/* eslint-env browser */

(() => {
  const root = document.querySelector('[data-mcp-chat]');
  if (!root) return;

  const form = root.querySelector('[data-composer]');
  const input = form.querySelector('textarea');
  const submit = form.querySelector('button');
  const messages = root.querySelector('[data-messages]');
  const empty = root.querySelector('[data-empty-state]');
  const applicationSelect = root.querySelector('[data-context-application]');
  const environmentSelect = root.querySelector('[data-context-environment]');
  let conversationId;

  async function loadCatalog() {
    try {
      const response = await fetch('/api/v1/mcp/catalog');
      if (!response.ok) return;
      const { applications } = await response.json();
      applications.forEach((application) => {
        const option = document.createElement('option');
        option.value = application.applicationId;
        option.textContent = application.name;
        option.dataset.environments = application.environments
          .filter((item) => item.enabled)
          .map((item) => ({ dev: 'development', prod: 'production' }[item.name] || item.name))
          .join(',');
        applicationSelect.appendChild(option);
      });
    } catch (_) { /* Context remains optional when the catalog is unavailable. */ }
  }

  function selectedContext() {
    const context = {
      openPage: 'unknown',
      language: document.documentElement.lang === 'en' ? 'en' : 'fr',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris',
    };
    if (applicationSelect.value) context.applicationId = applicationSelect.value;
    if (environmentSelect.value) context.environment = environmentSelect.value;
    return Object.keys(context).length ? context : undefined;
  }

  function updateEnvironmentOptions() {
    const selected = applicationSelect.selectedOptions[0];
    const enabled = selected && selected.dataset.environments
      ? selected.dataset.environments.split(',') : ['development', 'staging', 'production'];
    Array.from(environmentSelect.options).forEach((option) => {
      option.disabled = Boolean(option.value) && !enabled.includes(option.value);
    });
    if (environmentSelect.selectedOptions[0].disabled) environmentSelect.value = '';
  }

  function addMessage(kind, text, extraClass = '') {
    empty.hidden = true;
    const node = document.createElement('div');
    node.className = `mcp-message mcp-message-${kind} ${extraClass}`.trim();
    node.textContent = text;
    messages.appendChild(node);
    node.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return node;
  }

  function parseSseChunk(chunk, onEvent) {
    for (const block of chunk.split('\n\n')) {
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      try { onEvent(JSON.parse(dataLine.slice(6))); } catch (_) { /* ignore incomplete payloads */ }
    }
  }

  function renderEvent(event, assistant) {
    if (event.type === 'turn_started') conversationId = event.conversationId;
    if (event.type === 'tool_started') assistant.textContent = `Consultation de ${event.tool}...`;
    if (event.type === 'answer_delta') assistant.textContent = event.text;
    if (event.type === 'clarification_required') assistant.textContent = event.question;
    if (event.type === 'warning') addMessage('notice', event.message, 'mcp-message-warning');
    if (event.type === 'error') {
      assistant.textContent = event.message;
      const reference = document.createElement('small');
      reference.textContent = `Référence : ${event.correlationId}`;
      assistant.appendChild(reference);
    }
    if (event.type === 'turn_completed' && event.sources.length) {
      const source = document.createElement('small');
      source.textContent = `Sources : ${event.sources.map((item) => item.source).join(', ')}`;
      assistant.appendChild(source);
    }
  }

  async function send(message) {
    addMessage('user', message);
    const assistant = addMessage('assistant', 'Analyse de la demande...', 'mcp-message-loading');
    input.disabled = true;
    submit.disabled = true;

    try {
      const response = await fetch('/api/v1/mcp/chat/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CNP-CSRF': root.dataset.csrfToken },
        body: JSON.stringify({ conversationId, message, context: selectedContext() }),
      });
      if (!response.ok || !response.body) throw new Error('Chat request failed');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamFinished = false;
      while (!streamFinished) {
        const { done, value } = await reader.read();
        streamFinished = done;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary >= 0) {
          parseSseChunk(buffer.slice(0, boundary + 2), (event) => renderEvent(event, assistant));
          buffer = buffer.slice(boundary + 2);
        }
      }
    } catch (_) {
      assistant.textContent = 'Le service MCP est temporairement indisponible.';
    } finally {
      assistant.classList.remove('mcp-message-loading');
      input.disabled = false;
      submit.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    send(message);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  root.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => send(button.dataset.prompt));
  });
  applicationSelect.addEventListener('change', updateEnvironmentOptions);
  loadCatalog();
})();
