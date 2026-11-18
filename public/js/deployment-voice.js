/* global MediaRecorder, document, navigator, window */
(function () {
  'use strict';

  const questions = [
    { id: 'purpose', text: 'Que fait votre application et à qui est-elle destinée ?', required: true },
    { id: 'environment', text: 'Souhaitez-vous préparer un espace de test ou une version accessible aux utilisateurs ?', required: true },
    { id: 'data', text: 'Quelles informations votre application doit-elle conserver et retrouver après un redémarrage ?', required: true },
    { id: 'database', text: 'Votre application utilise-t-elle déjà une base de données ? Si oui, laquelle ?', required: true },
    { id: 'traffic', text: 'Combien de personnes l’utiliseront, et à quelle fréquence ? Un délai au premier accès après une période calme est-il acceptable ?', required: true },
    { id: 'cloud', text: 'Avez-vous une préférence de fournisseur cloud, une contrainte de localisation des données ou un budget à respecter ?', required: false },
    { id: 'technical', text: 'Savez-vous sur quel port votre application écoute ? Quelle équipe doit être responsable de son déploiement ?', required: false }
  ];
  const byId = (id) => document.getElementById(id);
  const choice = byId('deploymentModeChoice');
  const flow = byId('agentDeploymentFlow');
  const form = byId('newDeploymentForm');
  const status = byId('agentRecordingStatus');
  const prefillStatus = byId('agentPrefillStatus');
  const playback = byId('agentAnswerPlayback');
  const answers = new Map();
  let current = 0;
  let recorder = null;
  let stream = null;
  let playbackUrl = null;
  let busy = false;
  let session = 0;
  let controller = null;
  let recordingTimer = null;

  function revokePlayback() {
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
    playback.removeAttribute('src');
    playback.hidden = true;
  }

  function show(mode) {
    choice.hidden = mode !== 'choice';
    flow.hidden = mode !== 'agent';
    form.hidden = mode !== 'manual';
  }

  function setPrefillStatus(message, isError = false) {
    prefillStatus.textContent = message;
    prefillStatus.className = isError ? 'flash flash-error' : 'form-hint';
  }

  function missingRequired() {
    return questions.map((question, index) => question.required && !answers.has(question.id) ? index + 1 : null).filter(Boolean);
  }

  function render(preserveStatus = false) {
    const answer = answers.get(questions[current].id);
    byId('agentQuestionProgress').textContent = `Question ${current + 1} sur ${questions.length}${questions[current].required ? ' — obligatoire' : ' — facultative'}`;
    byId('agentQuestionText').textContent = questions[current].text;
    byId('agentPreviousQuestion').disabled = current === 0 || busy;
    byId('agentNextQuestion').disabled = current === questions.length - 1 || busy;
    byId('agentRecordStart').hidden = busy;
    byId('agentRecordStart').disabled = busy;
    byId('agentRecordStart').textContent = answer ? 'Réenregistrer ma réponse' : 'Enregistrer ma réponse';
    byId('agentRecordStop').hidden = !busy;
    byId('agentPrefill').disabled = busy;
    revokePlayback();
    if (answer) {
      playbackUrl = URL.createObjectURL(answer);
      playback.src = playbackUrl;
      playback.hidden = false;
    }
    if (!preserveStatus) status.textContent = answer ? 'Réponse enregistrée localement. Vous pouvez l’écouter ou la remplacer.' : 'Aucune réponse enregistrée pour cette question.';
    if (!preserveStatus) {
      const missing = missingRequired();
      setPrefillStatus(missing.length
        ? `Pour pré-remplir, enregistrez encore les réponses obligatoires ${missing.join(', ')}.`
        : 'Toutes les réponses obligatoires sont enregistrées. Vous pouvez demander le pré-remplissage.');
    }
  }

  function stopTracks() {
    if (recordingTimer) window.clearTimeout(recordingTimer);
    recordingTimer = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
    stopTracks();
  }

  async function startRecording() {
    if (busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      status.textContent = 'L’enregistrement audio n’est pas disponible dans ce navigateur.';
      return;
    }
    try {
      const activeSession = session;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (activeSession !== session || flow.hidden || byId('agentQuestionsStep').hidden) { stopTracks(); return; }
      const mimeType = ['audio/ogg', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const activeRecorder = recorder;
      const chunks = [];
      const questionId = questions[current].id;
      activeRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      activeRecorder.onstop = () => {
        if (activeSession !== session) return;
        if (chunks.length) answers.set(questionId, new Blob(chunks, { type: activeRecorder.mimeType }));
        busy = false;
        stopTracks();
        render();
      };
      recorder.start();
      busy = true;
      byId('agentRecordStart').hidden = true;
      byId('agentRecordStop').hidden = false;
      byId('agentPreviousQuestion').disabled = true;
      byId('agentNextQuestion').disabled = true;
      byId('agentPrefill').disabled = true;
      status.textContent = 'Enregistrement en cours… arrêt automatique après 60 secondes.';
      recordingTimer = window.setTimeout(stopRecording, 60000);
    } catch (error) {
      stopTracks();
      status.textContent = error.name === 'NotAllowedError'
        ? 'Accès au microphone refusé. Autorisez-le dans votre navigateur ou choisissez le formulaire manuel.'
        : 'Impossible de démarrer l’enregistrement. Réessayez ou choisissez le formulaire manuel.';
    }
  }

  async function toWav(blob) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioContext || !OfflineAudioContext) throw new Error('Conversion audio indisponible dans ce navigateur.');
    const context = new AudioContext();
    let decoded;
    try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
    finally { await context.close(); }
    const duration = Math.min(decoded.duration, 60);
    const offline = new OfflineAudioContext(1, Math.ceil(duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    function ascii(offset, value) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
    ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  function setField(name, value) {
    const control = byId(name);
    if (!control) return;
    if (control.tagName === 'SELECT' && value && !Array.from(control.options).some(o => o.value === value)) return;
    control.value = value || '';
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function addBlankOption(id) {
    const control = byId(id);
    if (control && !Array.from(control.options).some(o => o.value === '')) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '— À compléter —';
      control.prepend(option);
    }
  }

  async function readApiResponse(response) {
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Session expirée ou service indisponible. Rechargez la page, puis réessayez.');
    }
    try { return await response.json(); }
    catch (_) { throw new Error('Réponse du service invalide. Réessayez ou utilisez le formulaire manuel.'); }
  }

  async function prefill() {
    if (busy) return;
    const missing = missingRequired();
    if (missing.length) {
      setPrefillStatus(`Enregistrez d’abord les réponses obligatoires ${missing.join(', ')}.`, true);
      return;
    }
    busy = true;
    controller = new AbortController();
    const activeSession = session;
    byId('agentPrefill').disabled = true;
    byId('agentRecordStart').disabled = true;
    byId('agentPreviousQuestion').disabled = true;
    byId('agentNextQuestion').disabled = true;
    byId('agentBackToModes').disabled = true;
    byId('agentBackToIdentity').disabled = true;
    try {
      status.textContent = 'Vérification du service vocal…';
      setPrefillStatus('Vérification du service vocal…');
      const availability = await window.fetch('/deployments/voice/status', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
      });
      const availabilityResult = await readApiResponse(availability);
      if (!availability.ok || !availabilityResult.ready) {
        throw new Error(availabilityResult.message || 'Le service vocal n’est pas disponible. Vos réponses restent disponibles ici.');
      }
      const transcripts = [];
      for (const [index, question] of questions.entries()) {
        const answer = answers.get(question.id);
        if (!answer) continue;
        status.textContent = `Envoi et transcription de la réponse ${index + 1} sur ${questions.length}…`;
        setPrefillStatus(`Envoi de la réponse ${index + 1} sur ${questions.length}…`);
        const wav = await toWav(answer);
        if (activeSession !== session) return;
        const request = window.fetch(`/deployments/voice/transcribe/${question.id}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' },
          body: wav, signal: controller.signal
        });
        status.textContent = `Transcription de la réponse ${index + 1} sur ${questions.length}…`;
        setPrefillStatus(`Transcription de la réponse ${index + 1} sur ${questions.length}…`);
        const response = await request;
        const result = await readApiResponse(response);
        if (!response.ok) throw new Error(result.error || 'Transcription impossible.');
        transcripts.push({ id: question.id, text: result.text });
      }
      status.textContent = 'Analyse des réponses et préparation du formulaire…';
      setPrefillStatus('Analyse des réponses et préparation du formulaire…');
      const response = await window.fetch('/deployments/voice/analyze', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: transcripts, githubRepoUrl: byId('agentGithubRepoUrl').value.trim(),
          appName: byId('agentAppName').value.trim() }), signal: controller.signal
      });
      const result = await readApiResponse(response);
      if (!response.ok) throw new Error(result.error || 'Analyse impossible.');
      if (activeSession !== session) return;
      byId('githubRepoUrl').value = byId('agentGithubRepoUrl').value.trim();
      byId('appName').value = byId('agentAppName').value.trim();
      byId('appName').dataset.userEdited = '1';
      addBlankOption('environment');
      addBlankOption('stack');
      addBlankOption('billing');
      setField('environment', result.fields.environment);
      setField('stack', result.fields.stack);
      setField('billing', result.fields.billing);
      setField('appPort', result.fields.appPort);
      setField('ownerTeamId', result.fields.ownerTeamId);
      const notes = byId('agentRecommendations');
      notes.replaceChildren();
      const labels = { environment: 'Environnement', stack: 'Hébergement et données',
        billing: 'Facturation', appPort: 'Port', ownerTeamId: 'Équipe' };
      for (const [name, reason] of Object.entries(result.notes || {})) {
        const line = document.createElement('p');
        line.textContent = `${labels[name] || name} : ${reason}`;
        notes.append(line);
      }
      if (result.missing?.length) {
        const line = document.createElement('p');
        line.textContent = `À compléter ou vérifier : ${result.missing.join(', ')}.`;
        notes.append(line);
      }
      notes.hidden = !notes.childNodes.length;
      byId('agentPrefillNotice').hidden = false;
      show('manual');
      answers.clear();
      revokePlayback();
      status.textContent = '';
      setPrefillStatus('');
    } catch (error) {
      if (activeSession === session && error.name !== 'AbortError') {
        status.textContent = error.message || 'Pré-remplissage impossible. Vous pouvez réessayer ou utiliser le formulaire manuel.';
        setPrefillStatus(status.textContent, true);
      }
    } finally {
      if (activeSession === session) {
        busy = false;
        byId('agentRecordStart').disabled = false;
        byId('agentBackToModes').disabled = false;
        byId('agentBackToIdentity').disabled = false;
        render(true);
      }
    }
  }

  function close() {
    session++;
    controller?.abort();
    controller = null;
    stopRecording();
    busy = false;
    answers.clear();
    revokePlayback();
    current = 0;
    byId('agentQuestionsStep').hidden = true;
    byId('agentIdentityStep').hidden = false;
    byId('agentPrefillNotice').hidden = true;
    byId('agentRecommendations').hidden = true;
    show('choice');
  }

  byId('chooseManualDeployment').addEventListener('click', () => show('manual'));
  byId('chooseAgentDeployment').addEventListener('click', () => {
    show('agent');
    byId('agentGithubRepoUrl').value ||= byId('githubRepoUrl').value;
    byId('agentAppName').value ||= byId('appName').value;
    render();
  });
  byId('agentStartQuestions').addEventListener('click', () => {
    if (!byId('agentGithubRepoUrl').reportValidity() || !byId('agentAppName').reportValidity()) return;
    const repoInput = byId('agentGithubRepoUrl');
    let validRepo = false;
    try {
      const url = new URL(repoInput.value);
      validRepo = url.protocol === 'https:' && url.hostname === 'github.com' &&
        url.pathname.split('/').filter(Boolean).length === 2;
    } catch (_) { /* invalid URL */ }
    repoInput.setCustomValidity(validRepo ? '' : 'Saisissez une URL GitHub de la forme https://github.com/organisation/depot.');
    if (!repoInput.reportValidity()) return;
    byId('agentIdentityStep').hidden = true;
    byId('agentQuestionsStep').hidden = false;
    render();
  });
  byId('manualBackToModes').addEventListener('click', () => show('choice'));
  byId('agentBackToModes').addEventListener('click', () => { stopRecording(); show('choice'); });
  byId('agentBackToIdentity').addEventListener('click', () => {
    stopRecording(); byId('agentQuestionsStep').hidden = true; byId('agentIdentityStep').hidden = false;
  });
  byId('agentRecordStart').addEventListener('click', startRecording);
  byId('agentRecordStop').addEventListener('click', stopRecording);
  byId('agentPreviousQuestion').addEventListener('click', () => { if (!busy && current > 0) { current--; render(); } });
  byId('agentNextQuestion').addEventListener('click', () => { if (!busy && current < questions.length - 1) { current++; render(); } });
  byId('agentPrefill').addEventListener('click', prefill);
  byId('agentGithubRepoUrl').addEventListener('input', () => byId('agentGithubRepoUrl').setCustomValidity(''));
  window.CNPDeploymentVoice = { open: restoreDraft => { show(restoreDraft ? 'manual' : 'choice'); }, close };
}());
