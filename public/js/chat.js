/* CNP Portal — assistant chat (CNP-046).
 * Streams ChatEvents from POST /api/v1/mcp/chat/turn (SSE over fetch) and
 * renders them. All content is inserted with textContent (no HTML from the
 * server is ever interpreted). The conversation is kept in sessionStorage so
 * an error or a reload never loses it. */
(function () {
  'use strict';

  var STORAGE_KEY = 'cnp-chat-v1';
  var TOOL_LABELS = {
    list_applications: 'Recherche des applications',
    get_deployment_status: 'Lecture du statut de déploiement',
    get_application_logs: 'Lecture des logs',
    get_finops_recommendation: 'Calcul de la recommandation FinOps',
  };
  var TOOL_STATES = { running: 'en cours…', completed: 'terminé', failed: 'échec' };
  var SOURCE_STATES = { available: 'disponible', unavailable: 'indisponible', not_configured: 'non configurée' };
  var FINOPS_LABELS = {
    KEEP_CURRENT_CONFIGURATION: 'Conserver la configuration actuelle',
    RESIZE_RESOURCES: 'Redimensionner les ressources',
    EVALUATE_CLOUD_RUN: 'Évaluer Cloud Run',
    EVALUATE_GKE: 'Évaluer GKE',
    INSUFFICIENT_DATA: 'Données insuffisantes',
  };
  var NETWORK_ERROR = {
    code: 'AI_CLIENT_UNAVAILABLE', category: 'unavailable', retryable: true,
    message: 'L\'assistant est momentanément indisponible. Votre conversation est conservée, vous pouvez réessayer.',
  };

  var messagesEl = document.getElementById('chat-messages');
  var emptyEl = document.getElementById('chat-empty');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send');
  var appSelect = document.getElementById('chat-app');
  var envSelect = document.getElementById('chat-env');
  var busy = false;

  var state = load() || newConversation();

  function newConversation() {
    return { conversationId: uuid(), turns: [] };
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function load() {
    try { return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
  }

  function save() {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* storage unavailable */ }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function orDash(v) {
    return v === null || v === undefined || v === '' ? '—' : v;
  }

  function keyValues(rows) {
    var dl = el('dl', 'chat-kv');
    rows.forEach(function (r) {
      dl.appendChild(el('dt', null, r[0]));
      dl.appendChild(el('dd', null, orDash(r[1])));
    });
    return dl;
  }

  function list(title, items) {
    var wrap = el('div', 'chat-list');
    if (!items || !items.length) return wrap;
    wrap.appendChild(el('div', 'chat-list-title', title));
    var ul = el('ul');
    items.forEach(function (i) { ul.appendChild(el('li', null, i)); });
    wrap.appendChild(ul);
    return wrap;
  }

  // ── Structured responses ──────────────────────────────────────────────────

  function renderStructured(item) {
    var d = item.data || {};
    var box = el('div', 'chat-structured');

    if (item.kind === 'application_list') {
      box.appendChild(el('div', 'chat-structured-title', 'Applications'));
      var table = el('table');
      var head = el('tr');
      ['Application', 'Équipe', 'Environnements'].forEach(function (h) { head.appendChild(el('th', null, h)); });
      table.appendChild(head);
      (d.applications || []).forEach(function (a) {
        var tr = el('tr');
        tr.appendChild(el('td', null, a.name || a.applicationId));
        tr.appendChild(el('td', null, orDash(a.team)));
        tr.appendChild(el('td', null, (a.environments || []).filter(function (e) { return e.enabled; }).map(function (e) { return e.name; }).join(', ') || '—'));
        table.appendChild(tr);
      });
      box.appendChild(table);
    } else if (item.kind === 'deployment_status') {
      var desired = d.desiredState || {};
      var observed = d.observedState || {};
      box.appendChild(el('div', 'chat-structured-title', 'Déploiement — ' + orDash(d.applicationId) + ' (' + orDash(d.environment) + ')'));
      box.appendChild(keyValues([
        ['Version attendue (Git)', desired.version],
        ['Version observée', observed.version],
        ['Synchronisation (Argo CD)', observed.syncStatus],
        ['Santé', observed.healthStatus],
        ['Dérive détectée', d.driftDetected === null || d.driftDetected === undefined ? null : (d.driftDetected ? 'oui' : 'non')],
        ['Dernier déploiement', d.lastDeploymentAt],
      ]));
    } else if (item.kind === 'application_logs') {
      box.appendChild(el('div', 'chat-structured-title', 'Logs'));
      var logs = el('div', 'chat-logs');
      (d.logs || []).slice(0, 200).forEach(function (l) {
        var line = el('div', 'log-line');
        line.appendChild(el('span', 'log-ts', l.timestamp));
        line.appendChild(el('span', 'log-level-' + String(l.level || '').toLowerCase(), ' ' + orDash(l.level) + ' '));
        line.appendChild(el('span', null, l.message));
        logs.appendChild(line);
      });
      box.appendChild(logs);
      var notes = [];
      if (d.truncated) notes.push('Résultat tronqué.');
      if (d.redactedFields) notes.push(d.redactedFields + ' champ(s) sensible(s) masqué(s).');
      if (notes.length) box.appendChild(el('div', 'text-muted chat-note', notes.join(' ')));
    } else if (item.kind === 'finops_recommendation') {
      var u = d.utilization || {};
      var pct = function (v) { return v === null || v === undefined ? null : v + ' %'; };
      var money = function (v) { return v === null || v === undefined ? 'Non disponible' : v + ' ' + (d.currency || ''); };
      box.appendChild(el('div', 'chat-structured-title', 'Recommandation FinOps (efficacité des ressources)'));
      box.appendChild(keyValues([
        ['Recommandation', FINOPS_LABELS[d.recommendation] || d.recommendation],
        ['Confiance', d.confidence],
        ['CPU moyen / pic', [pct(u.averageCpuPercent), pct(u.peakCpuPercent)].map(orDash).join(' / ')],
        ['Mémoire moyenne / pic', [pct(u.averageMemoryPercent), pct(u.peakMemoryPercent)].map(orDash).join(' / ')],
        ['Coût mensuel actuel', money(d.currentMonthlyCost)],
        ['Économie estimée', money(d.estimatedMonthlySavings)],
      ]));
      box.appendChild(list('Hypothèses', d.assumptions));
      box.appendChild(list('Risques', d.risks));
      box.appendChild(list('Prérequis', d.prerequisites));
      box.appendChild(list('Prochaines étapes', d.nextSteps));
    }
    return box;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  function renderUserTurn(turn) {
    var wrap = el('div', 'chat-turn chat-turn-user');
    wrap.appendChild(el('div', 'chat-bubble', turn.text));
    return wrap;
  }

  function renderAssistantTurn(turn, index) {
    var wrap = el('div', 'chat-turn chat-turn-assistant');
    var bubble = el('div', 'chat-bubble');
    wrap.appendChild(bubble);

    var tools = Object.keys(turn.tools || {});
    if (tools.length) {
      var toolsEl = el('div', 'chat-tools');
      tools.forEach(function (t) {
        var s = turn.tools[t];
        toolsEl.appendChild(el('span', 'chat-tool chat-tool-' + s, (TOOL_LABELS[t] || t) + ' — ' + (TOOL_STATES[s] || s)));
      });
      bubble.appendChild(toolsEl);
    }

    if (turn.status === 'loading' && !turn.answer && !tools.length) {
      bubble.appendChild(el('div', 'chat-loading', 'Analyse de votre demande…'));
    }

    if (turn.rejected) {
      var rej = el('div', 'chat-notice chat-notice-rejected');
      rej.appendChild(el('strong', null, 'Hors du périmètre lecture seule. '));
      rej.appendChild(document.createTextNode(turn.rejected));
      bubble.appendChild(rej);
    }

    if (turn.clarification) {
      var cl = el('div', 'chat-notice chat-notice-clarify');
      cl.appendChild(el('div', null, turn.clarification.question));
      if (turn.clarification.options && turn.clarification.options.length) {
        var opts = el('div', 'chat-suggestions');
        turn.clarification.options.forEach(function (o) {
          var b = el('button', 'chat-chip', o);
          b.type = 'button';
          b.setAttribute('data-suggestion', o);
          opts.appendChild(b);
        });
        cl.appendChild(opts);
      }
      bubble.appendChild(cl);
    }

    (turn.structured || []).forEach(function (s) { bubble.appendChild(renderStructured(s)); });

    if (turn.answer) bubble.appendChild(el('div', 'chat-answer', turn.answer));

    (turn.warnings || []).forEach(function (w) {
      bubble.appendChild(el('div', 'chat-notice chat-notice-warning', '⚠ ' + w.message));
    });

    if (turn.error) {
      var err = el('div', 'chat-notice chat-notice-error chat-error-' + turn.error.category);
      err.appendChild(el('div', null, turn.error.message));
      if (turn.error.category === 'forbidden' && turn.error.code === 'UNAUTHENTICATED') {
        var login = el('a', 'btn btn-secondary btn-sm', 'Se reconnecter');
        login.href = '/auth/login';
        err.appendChild(login);
      } else if (turn.error.retryable && turn.request) {
        var retry = el('button', 'btn btn-secondary btn-sm', 'Réessayer');
        retry.type = 'button';
        retry.setAttribute('data-retry', String(index));
        err.appendChild(retry);
      }
      bubble.appendChild(err);
    }

    if (turn.sources && turn.sources.length) {
      var src = el('div', 'chat-sources');
      src.appendChild(el('span', 'text-muted', 'Sources : '));
      turn.sources.forEach(function (s) {
        var cls = s.status === 'available' ? 'badge badge-success' : s.status === 'unavailable' ? 'badge badge-danger' : 'badge badge-gray';
        src.appendChild(el('span', cls, s.source + ' — ' + (SOURCE_STATES[s.status] || s.status)));
      });
      bubble.appendChild(src);
    }

    var meta = [];
    if (turn.status === 'partial') meta.push('Réponse partielle');
    if (turn.correlationId) meta.push('ID de corrélation : ' + turn.correlationId);
    if (meta.length) bubble.appendChild(el('div', 'chat-meta', meta.join(' · ')));
    return wrap;
  }

  function renderTurn(turn, index) {
    return turn.role === 'user' ? renderUserTurn(turn) : renderAssistantTurn(turn, index);
  }

  function renderAll() {
    Array.prototype.slice.call(messagesEl.querySelectorAll('.chat-turn')).forEach(function (n) { n.remove(); });
    emptyEl.style.display = state.turns.length ? 'none' : '';
    state.turns.forEach(function (t, i) {
      var node = renderTurn(t, i);
      node.setAttribute('data-index', String(i));
      messagesEl.appendChild(node);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function rerender(index) {
    var old = messagesEl.querySelector('.chat-turn[data-index="' + index + '"]');
    var node = renderTurn(state.turns[index], index);
    node.setAttribute('data-index', String(index));
    if (old) old.replaceWith(node); else messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  function applyEvent(turn, type, data) {
    switch (type) {
      case 'tool_status': turn.tools[data.tool] = data.state; break;
      case 'answer_delta': turn.answer += data.text; turn.status = 'streaming'; break;
      case 'source': turn.sources.push(data); break;
      case 'warning': turn.warnings.push(data); break;
      case 'structured': turn.structured.push(data); break;
      case 'clarification_required': turn.clarification = data; break;
      case 'rejected': turn.rejected = data.message; break;
      case 'completed': turn.status = data.status; turn.correlationId = data.correlationId; break;
      case 'error': turn.status = 'error'; turn.error = data; turn.correlationId = data.correlationId; break;
      default: break;
    }
  }

  function parseBlock(block) {
    var type = 'message';
    var data = [];
    block.split(/\r?\n/).forEach(function (line) {
      if (line.indexOf('event:') === 0) type = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
    });
    if (!data.length) return null;
    try { return { type: type, data: JSON.parse(data.join('\n')) }; } catch (_) { return null; }
  }

  async function runTurn(index) {
    var turn = state.turns[index];
    busy = true;
    sendBtn.disabled = true;
    rerender(index);
    try {
      var res = await fetch('/api/v1/mcp/chat/turn', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ conversationId: state.conversationId, message: turn.request.message, context: turn.request.context }),
      });
      if (!res.ok || !res.body) {
        var body = null;
        try { body = await res.json(); } catch (_) { /* not JSON */ }
        applyEvent(turn, 'error', body && body.message ? body : NETWORK_ERROR);
      } else {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
            var ev = parseBlock(buffer.slice(0, idx));
            buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
            if (ev) { applyEvent(turn, ev.type, ev.data); rerender(index); }
          }
        }
        if (turn.status === 'loading' || turn.status === 'streaming') applyEvent(turn, 'error', NETWORK_ERROR);
      }
    } catch (_) {
      applyEvent(turn, 'error', NETWORK_ERROR);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      rerender(index);
      save();
      input.focus();
    }
  }

  function freshAssistantTurn(request) {
    return { role: 'assistant', request: request, status: 'loading', answer: '', tools: {}, sources: [], warnings: [], structured: [], clarification: null, rejected: null, error: null, correlationId: null };
  }

  function send(message) {
    message = (message || '').trim();
    if (!message || busy) return;
    var request = { message: message, context: { applicationId: appSelect.value || undefined, environment: envSelect.value || undefined } };
    state.turns.push({ role: 'user', text: message });
    state.turns.push(freshAssistantTurn(request));
    save();
    renderAll();
    input.value = '';
    runTurn(state.turns.length - 1);
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  messagesEl.addEventListener('click', function (e) {
    var target = e.target;
    if (target.hasAttribute('data-suggestion')) send(target.getAttribute('data-suggestion'));
    if (target.hasAttribute('data-retry') && !busy) {
      var i = parseInt(target.getAttribute('data-retry'), 10);
      state.turns[i] = freshAssistantTurn(state.turns[i].request);
      runTurn(i);
    }
  });
  document.getElementById('chat-reset').addEventListener('click', function () {
    if (busy) return;
    state = newConversation();
    save();
    renderAll();
  });

  // A turn interrupted by a reload cannot be resumed: mark it as failed (retryable).
  state.turns.forEach(function (t) {
    if (t.role === 'assistant' && (t.status === 'loading' || t.status === 'streaming')) applyEvent(t, 'error', NETWORK_ERROR);
  });
  renderAll();
})();
