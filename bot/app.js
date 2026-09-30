(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let session = null;
  let busy = false;
  let sendingMessage = false;
  let recordingAttempt = null;
  let pendingAudio = null;
  let pendingMessage = null;
  let pendingMessageIsAudio = false;
  let messageNeedsRetry = false;
  let available = false;
  let visitEnded = false;
  let accessMessage = '';
  let completedReportAvailable = false;
  let welcoming = false;
  let welcomeTimer = null;
  const showError = (message = '') => { $('error').textContent = message; $('error').hidden = !message; };
  const api = async (path, body) => {
    let response;
    try {
      response = await fetch(`/api/bot/${path}`, {
        credentials: 'same-origin', cache: 'no-store',
        ...(body ? { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' } } : {}),
        // The message endpoint has one shared 20-second AI budget. Audio also
        // needs time to upload (up to four minutes of recording).
        signal: AbortSignal.timeout(path === 'transcribe' ? 100_000 : 30_000),
      });
    } catch {
      throw new Error('No pudimos confirmar la respuesta del asistente. Revisá tu conexión e intentá de nuevo.');
    }
    const data = await response.json().catch(() => { throw new Error('No pudimos conectar con el asistente. Intentá de nuevo en unos segundos.'); });
    if (!response.ok) throw new Error(data.error || 'No pudimos completar la solicitud. Intentá de nuevo.');
    return data;
  };
  const updateControls = () => {
    const capturing = Boolean(recordingAttempt);
    $('cancel-recording').hidden = !capturing;
    $('send').hidden = capturing;
    $('send').disabled = busy || welcoming || capturing || Boolean(pendingMessage || pendingAudio) || !$('message').value.trim();
    $('message').disabled = (busy && !sendingMessage) || welcoming || capturing;
    $('record').disabled = busy || welcoming || Boolean(recordingAttempt?.starting || recordingAttempt?.stopping) || Boolean(pendingMessage || pendingAudio);
    $('retry-audio').disabled = busy || capturing;
    // Once its message may have reached the server, discarding cannot safely
    // reset the request/version. Reconcile it with the same id first.
    $('discard-audio').disabled = busy || capturing || Boolean(pendingMessage && pendingMessageIsAudio);
    $('message-retry').hidden = !messageNeedsRetry || pendingMessageIsAudio;
    $('retry-message').disabled = busy || capturing;
    $('start').disabled = busy || Boolean(session) || !available || !$('consent').checked;
    $('typing').hidden = !busy || !session;
  };
  const setBusy = (value) => { busy = value; updateControls(); };
  const renderMessages = (messages) => {
    $('messages').replaceChildren();
    for (const message of messages) {
      const bubble = document.createElement('p');
      bubble.className = `bubble ${message.role === 'user' ? 'user' : ''}`;
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = message.role === 'user' ? 'VOS' : 'REKU';
      bubble.append(label, document.createTextNode(message.text));
      $('messages').append(bubble);
    }
    $('messages').scrollTop = $('messages').scrollHeight;
  };
  const brandPage = (brand) => {
    const cobranded = brand.cobranded && /^\/uploads\/agreements\/[\w.-]+$/.test(brand.logo_url || '');
    document.body.classList.toggle('cobranded', Boolean(cobranded));
    document.documentElement.dataset.agreementTheme = cobranded && brand.brand_theme === 'ypf-os' ? 'ypf-os' : '';
    $('agreement-logo').hidden = !cobranded;
    if (cobranded) { $('agreement-logo').src = '/api/bot/logo'; $('agreement-logo').alt = brand.name; }
    $('brand-caption').textContent = brand.slug ? `${brand.name} · Telerehabilitación con Reku` : 'Reku · Telerehabilitación con acompañamiento profesional';
  };
  const render = () => {
    $('access-notice').hidden = !accessMessage;
    $('access-notice').textContent = accessMessage;
    $('messages').hidden = Boolean(accessMessage);
    $('chat-card').hidden = !session || Boolean(accessMessage);
    $('intro').hidden = (Boolean(session) && !accessMessage) || completedReportAvailable;
    $('completed-report').hidden = !completedReportAvailable;
    $('completed-report-message').textContent = completedReportAvailable ? accessMessage : '';
    $('layout').classList.toggle('awaiting-start', !session);
    const messages = session?.messages || [];
    renderMessages(welcoming ? messages.slice(0, 1) : messages);
    $('start-panel').hidden = Boolean(session) || Boolean(accessMessage);
    const done = session && session.status !== 'collecting';
    $('composer').hidden = !session || done;
    $('result').hidden = !done;
    $('chat-status').textContent = done ? 'Tu relato quedó resumido' : 'Te acompañamos antes de la consulta';
    if (session) brandPage(session.brand);
    if (done) {
      $('result-title').textContent = session.status === 'partial' ? 'Tu informe parcial está listo' : 'Tu informe está listo';
      $('result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    updateControls();
  };
  const clearAudio = () => {
    pendingAudio = null;
    $('audio-retry').hidden = true;
  };
  $('consent').addEventListener('change', updateControls);
  $('start').addEventListener('click', async () => {
    if (busy || session || !available || !$('consent').checked || visitEnded) return;
    setBusy(true); showError();
    try {
      const created = (await api('session', { consent: true })).session;
      if (visitEnded) { closeSession(created); return; }
      session = created;
      welcoming = session.status === 'collecting' && session.messages.length > 1;
      render();
      $('chat-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (welcoming) {
        welcomeTimer = setTimeout(() => {
          welcomeTimer = null;
          if (visitEnded || session !== created) return;
          welcoming = false; render(); $('message').focus();
        }, 2000);
      } else { $('message').focus(); }
    }
    catch (error) { showError(error.message); }
    finally { setBusy(false); }
  });
  $('message').addEventListener('input', updateControls);
  $('message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
  });
  const sendMessage = async (text, { fromAudio = false } = {}) => {
    if (!session || visitEnded) return;
    const isNew = !pendingMessage;
    if (isNew) {
      pendingMessage = Object.freeze({ text, requestId: crypto.randomUUID(), version: session.version, instanceId: session.instanceId });
      pendingMessageIsAudio = fromAudio;
    }
    const request = pendingMessage;
    const audioMessage = pendingMessageIsAudio;
    messageNeedsRetry = false;
    sendingMessage = true;
    setBusy(true); showError();
    renderMessages([...session.messages, { role: 'user', text: request.text }]);
    if (isNew && !audioMessage) $('message').value = '';
    updateControls(); $('message').focus();
    try {
      const updated = (await api('message', request)).session;
      if (visitEnded) return;
      session = updated;
      const decisions = (session.followupDiagnostics || []).filter(item => item.turn === session.version);
      if (decisions.length) console.info('Reku: control de preguntas adicionales', { diagnosticId: session.diagnosticId, decisions });
      pendingMessage = null;
      pendingMessageIsAudio = false;
      render();
    } catch (error) {
      if (visitEnded) return;
      messageNeedsRetry = true;
      // Keep the uncertain send immutable and separate from the next draft.
      // A retry may recover an already-committed response from the server.
      renderMessages([...session.messages, { role: 'user', text: request.text }]); showError(error.message);
      if (audioMessage) throw error;
    }
    finally { sendingMessage = false; setBusy(false); if (!visitEnded) $('message').focus(); }
  };
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value.trim();
    if (!text || busy || welcoming || recordingAttempt || pendingMessage || pendingAudio || !session) return;
    await sendMessage(text);
  });
  $('retry-message').addEventListener('click', async () => {
    if (busy || recordingAttempt || !pendingMessage || pendingMessageIsAudio || !messageNeedsRetry) return;
    await sendMessage(pendingMessage.text);
  });
  const sendAudio = async () => {
    if (!pendingAudio || busy || recordingAttempt || !session || (pendingMessage && !pendingMessageIsAudio)) return;
    const audio = pendingAudio;
    if (audio.file.size > 8 * 1024 * 1024) { showError('El audio debe pesar menos de 8 MB.'); $('audio-retry').hidden = false; updateControls(); return; }
    setBusy(true); showError(); $('audio-retry').hidden = true;
    try {
      if (!audio.text) {
        const form = new FormData(); form.append('audio', audio.file, audio.file.name || 'consulta.webm');
        const result = await api('transcribe', form);
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (!text || text.length > 12000) throw new Error('No pudimos entender el audio. Probá grabar nuevamente.');
        audio.text = text;
      }
      if (visitEnded) return;
      await sendMessage(audio.text, { fromAudio: true });
      clearAudio();
    } catch (error) { if (!visitEnded) { showError(error.message); $('audio-retry').hidden = false; } }
    finally { setBusy(false); if (!visitEnded) $('message').focus(); }
  };
  const releaseRecordingResources = (attempt) => {
    clearInterval(attempt.voiceTimer); clearInterval(attempt.recordTimer);
    attempt.stream?.getTracks().forEach(track => track.stop());
    attempt.stream = null;
    attempt.context?.close().catch(() => {}); attempt.context = null;
  };
  const resetRecordingControls = () => {
    $('recording-note').hidden = true;
    $('record-label').textContent = 'Grabar audio'; $('record').classList.remove('recording');
    $('record').setAttribute('aria-label', 'Grabar audio');
    $('record').setAttribute('title', 'Grabar audio');
  };
  const stopRecording = (discard = false) => {
    const attempt = recordingAttempt;
    if (!attempt) return;
    attempt.discard ||= discard;
    attempt.stopping = true;
    if (attempt.starting) { recordingAttempt = null; }
    else {
      setBusy(true);
      // A few browser/device failures omit the final stop event. Release the
      // interface and send any already-delivered chunks exactly once anyway.
      attempt.stopTimer ??= setTimeout(() => { void attempt.finish(); }, 2000);
      try { if (attempt.recorder?.state === 'recording') attempt.recorder.stop(); }
      catch { attempt.stopFailed = true; }
    }
    releaseRecordingResources(attempt);
    resetRecordingControls();
    updateControls();
  };
  $('record').addEventListener('click', async () => {
    if (recordingAttempt?.recorder?.state === 'recording') { stopRecording(); return; }
    if (recordingAttempt || busy || welcoming || pendingMessage || pendingAudio || !session || visitEnded) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showError('Este navegador no permite grabar. Podés escribir tu mensaje.'); return; }
    const attempt = { starting: true, stopping: false, discard: false, audibleSamples: 0 };
    recordingAttempt = attempt;
    const isCurrent = () => recordingAttempt === attempt && !attempt.discard && !visitEnded;
    showError(); updateControls();
    try {
      attempt.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) { releaseRecordingResources(attempt); return; }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('AUDIO_METER_UNAVAILABLE');
      attempt.context = new AudioContext();
      await attempt.context.resume();
      if (!isCurrent()) { releaseRecordingResources(attempt); return; }
      const analyser = attempt.context.createAnalyser(); analyser.fftSize = 2048;
      attempt.context.createMediaStreamSource(attempt.stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      attempt.voiceTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        if (rms > 0.008) attempt.audibleSamples++;
      }, 50);
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(attempt.stream, { audioBitsPerSecond: 64000, ...(type ? { mimeType: type } : {}) });
      attempt.recorder = recorder;
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      attempt.finish = async () => {
        if (attempt.finished) return;
        attempt.finished = true;
        clearTimeout(attempt.stopTimer);
        releaseRecordingResources(attempt);
        if (recordingAttempt !== attempt) return;
        recordingAttempt = null; resetRecordingControls();
        setBusy(false);
        if (attempt.discard || visitEnded) return;
        if (attempt.audibleSamples < 5) {
          showError('No detectamos voz. Tocá Grabar audio y probá nuevamente.');
        } else if (chunks.length) {
          const mime = recorder.mimeType.split(';')[0];
          pendingAudio = { file: new File(chunks, `consulta.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }), text: '' };
          await sendAudio();
        } else {
          showError('No pudimos recuperar el audio de este navegador. Podés grabarlo de nuevo o escribir tu mensaje.');
        }
      };
      recorder.onstop = attempt.finish;
      recorder.onerror = () => { if (!isCurrent()) return; attempt.stopFailed = true; stopRecording(); };
      recorder.start();
      attempt.starting = false;
      const startedAt = Date.now(); $('timer').textContent = '0:00';
      attempt.recordTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (seconds >= 240) stopRecording();
      }, 500);
      $('recording-note').hidden = false; $('record-label').textContent = 'Enviar'; $('record').classList.add('recording');
      $('record').setAttribute('aria-label', 'Enviar audio');
      $('record').setAttribute('title', 'Enviar audio');
    } catch {
      releaseRecordingResources(attempt);
      if (recordingAttempt === attempt) {
        recordingAttempt = null; resetRecordingControls();
        if (!visitEnded) showError('No pudimos iniciar la grabación. Revisá el permiso del micrófono o escribí tu mensaje.');
      }
    }
    finally { updateControls(); }
  });
  $('cancel-recording').addEventListener('click', () => stopRecording(true));
  $('retry-audio').addEventListener('click', sendAudio);
  $('discard-audio').addEventListener('click', () => { if (busy || (pendingMessage && pendingMessageIsAudio)) return; clearAudio(); showError(); updateControls(); });
  const downloadReport = async (button) => {
    button.disabled = true; showError();
    try {
      const response = await fetch('/api/bot/report', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'reku-motivo-de-consulta.pdf'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { showError(error.message || 'No pudimos descargar el informe.'); }
    finally { button.disabled = false; }
  };
  $('download').addEventListener('click', () => downloadReport($('download')));
  $('download-completed').addEventListener('click', () => downloadReport($('download-completed')));
  const closeSession = (current) => {
    if (!current?.instanceId) return;
    const body = JSON.stringify({ instanceId: current.instanceId });
    try {
      if (navigator.sendBeacon?.('/api/bot/close', new Blob([body], { type: 'application/json' }))) return;
      fetch('/api/bot/close', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    } catch { /* On abrupt exit, the next visit resets it; TTL is a final fallback. */ }
  };
  window.addEventListener('pagehide', () => {
    visitEnded = true;
    clearTimeout(welcomeTimer); welcomeTimer = null; welcoming = false;
    available = false;
    completedReportAvailable = false;
    closeSession(session);
    stopRecording(true); clearAudio(); pendingMessage = null; pendingMessageIsAudio = false; messageNeedsRetry = false; session = null;
    $('message').value = ''; $('consent').checked = false;
    render();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  const init = async () => {
    render();
    try {
      const linkToken = new URLSearchParams((location.hash || '').slice(1)).get('appointment');
      if (linkToken !== null) {
        // Private access tokens never remain in navigation/history or query URLs.
        history.replaceState(null, '', location.pathname + location.search);
        try { await api('access', { token: linkToken }); }
        catch (error) { accessMessage = error.message; available = false; render(); return; }
      }
      await api('reset', {});
      if (visitEnded) return;
      const context = await api('context');
      if (visitEnded) return;
      accessMessage = context.access?.allowed === false ? context.access.message : '';
      completedReportAvailable = context.access?.completed === true && context.access?.reportAvailable === true;
      available = context.available && !accessMessage; brandPage(context.brand);
      session = null; $('message').value = ''; $('consent').checked = false; render();
      if (!available && !accessMessage) showError('El asistente todavía no está disponible.');
    } catch (error) { showError(error.message || 'No pudimos iniciar el asistente. Recargá la página.'); }
  };
  init();
})();
