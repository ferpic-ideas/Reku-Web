(() => {
  const button = document.getElementById('activate-button');
  const message = document.getElementById('activation-message');
  const storageKey = 'reku-push-activation';
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let token = fragment.get('activar') || '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const needsInstall = ios && !standalone;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let registration;
  let activation;
  let action = 'retry';
  let busy = false;

  try {
    if (token) sessionStorage.setItem(storageKey, token);
    else token = sessionStorage.getItem(storageKey) || '';
  } catch { /* The email fragment also works when storage is unavailable. */ }
  // iOS installs the document URL as start_url (the activation manifest omits it).
  // Keep the fragment until installation; it is never sent in HTTP requests.
  if (!needsInstall) window.history.replaceState({}, '', window.location.pathname);

  const showMessage = (text, error = false) => {
    message.textContent = text;
    message.className = error ? 'error' : '';
  };
  const showDeniedPermission = () => {
    showMessage(ios
      ? 'Las notificaciones están bloqueadas. Abrí Ajustes → Notificaciones → Reku (o el nombre de tu ícono) y habilitá Permitir notificaciones. Después volvé aquí y tocá Volver a comprobar.'
      : /android/i.test(navigator.userAgent || '')
        ? 'Las notificaciones están bloqueadas. En Chrome, tocá el ícono a la izquierda de la dirección → Permisos → Notificaciones → Permitir. Después volvé aquí y tocá Volver a comprobar.'
        : 'Las notificaciones están bloqueadas. Habilitalas en los permisos de este sitio y después tocá Volver a comprobar.', true);
    button.textContent = 'Volver a comprobar';
    button.hidden = false;
  };
  const api = async (suffix, body = {}) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/professional/notifications/push/activation${suffix}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token }),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || 'No pudimos completar la activación.'), { status: response.status });
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('La conexión tardó demasiado. Volvé a intentar.');
      throw error;
    } finally { window.clearTimeout(timer); }
  };
  const success = () => {
    document.getElementById('activation-title').textContent = 'Notificaciones activadas';
    document.getElementById('activation-description').textContent = 'Ya quedó todo preparado.';
    document.getElementById('activation-success').hidden = false;
    button.hidden = true;
    showMessage('');
    try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
    window.history.replaceState({}, '', window.location.pathname);
  };
  const publicKeyBytes = (value) => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (character) => character.charCodeAt(0));
  };
  async function prepareWorker() {
    const worker = await navigator.serviceWorker.register('/profesional/service-worker.js', { scope: '/profesional/' });
    let timer;
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('No pudimos preparar las notificaciones. Volvé a intentar.')), 8_000); }),
      ]);
    } finally { window.clearTimeout(timer); }
    return worker;
  }
  async function activate() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      // Request permission directly from the click, before any asynchronous work.
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') {
        if (permission === 'denied') { showDeniedPermission(); return; }
        throw new Error('El navegador no concedió el permiso. Volvé a tocar Permitir notificaciones y elegí Permitir cuando aparezca el aviso.');
      }
      showMessage('Activando notificaciones…');
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: publicKeyBytes(activation.public_key),
      });
      await api('/subscribe', {
        subscription: subscription.toJSON(),
        device_kind: ios || /android|mobile/i.test(navigator.userAgent || '') ? 'mobile' : 'desktop',
        device_label: ios ? 'iPhone / iPad' : /android/i.test(navigator.userAgent || '') ? 'Teléfono Android' : 'Computadora',
      });
      success();
    } catch (error) {
      showMessage(error.message, true);
      button.hidden = [401, 409].includes(error.status);
    } finally { busy = false; button.disabled = false; }
  }
  async function initialize() {
    button.hidden = true;
    showMessage('Verificando tu enlace…');
    try {
      if (!token) throw Object.assign(new Error('Abrí el enlace personal que recibiste por mail para activar este dispositivo.'), { status: 401 });
      activation = await api('');
      const name = document.getElementById('activation-name');
      name.textContent = activation.name;
      name.hidden = false;
      if (!activation.configured) throw new Error('Las notificaciones todavía no están habilitadas por Reku. Volvé a intentar más tarde.');
      document.getElementById('activation-description').textContent = 'Recibí avisos cuando un paciente esté esperando. No necesitás iniciar sesión.';
      if (needsInstall) {
        if (activation.used) throw Object.assign(new Error('Este enlace ya se usó. Pedí uno nuevo para activar otro dispositivo.'), { status: 409 });
        document.getElementById('install-guide').hidden = false;
        document.getElementById('install-browser-hint').textContent = /CriOS/i.test(navigator.userAgent || '')
          ? 'En Chrome, tocá Compartir a la derecha de la barra de direcciones y luego Agregar a inicio.'
          : 'En Safari o Chrome, tocá Compartir y luego Agregar a inicio.';
        showMessage('');
        return;
      }
      if (!supported) throw Object.assign(new Error('Este navegador no admite notificaciones. Abrí el enlace en Chrome en Android o Safari en iPhone.'), { status: 422 });
      registration = await prepareWorker();
      if (activation.used) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          const current = await api('', { subscription: subscription.toJSON() });
          if (current.active && Notification.permission === 'granted') { success(); return; }
        }
        throw Object.assign(new Error('Este enlace ya se usó. Pedí uno nuevo para activar otro dispositivo.'), { status: 409 });
      }
      action = 'activate';
      if (Notification.permission === 'denied') { showDeniedPermission(); return; }
      button.textContent = 'Permitir notificaciones';
      button.hidden = false;
      showMessage('Solo falta aceptar el permiso de este dispositivo.');
      if (Notification.permission === 'granted') await activate();
    } catch (error) {
      showMessage(error.message, true);
      action = 'retry';
      button.textContent = 'Reintentar';
      button.hidden = [401, 409, 422].includes(error.status);
    }
  }
  button.addEventListener('click', () => action === 'activate' ? activate() : initialize());
  document.getElementById('copy-activation-link').addEventListener('click', async () => {
    if (!token) return;
    const link = new URL('/profesional/activar-notificaciones.html', window.location.origin);
    link.hash = `activar=${encodeURIComponent(token)}`;
    const copyMessage = document.getElementById('copy-link-message');
    try {
      await navigator.clipboard.writeText(link.toString());
      copyMessage.textContent = 'Enlace copiado. Abrí Safari y pegalo en la barra de direcciones.';
    } catch {
      const input = document.getElementById('manual-copy-link');
      input.value = link.toString();
      document.getElementById('manual-copy-label').hidden = false;
      input.focus();
      input.select();
      copyMessage.textContent = 'Mantené presionado el enlace para copiarlo y pegalo en Safari.';
    }
  });
  void initialize();
})();
