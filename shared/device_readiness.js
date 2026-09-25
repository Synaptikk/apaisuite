const REVIEWED_KEY = 'apai.deviceSetupReviewed.v1';

export async function deviceReadiness(storage = chrome.storage, now = Date.now()) {
  const [local, sync, session] = await Promise.all([
    storage.local.get(REVIEWED_KEY), storage.sync.get('workvivo.apiKey'),
    storage.session.get(['aurorbuddy.auror.jwt', 'safetyagent.safepass.token']),
  ]);
  const fresh = (key, ttl) => !!session[key]?.value && now - session[key].at < ttl;
  return { reviewed: !!local[REVIEWED_KEY], workvivoConfigured: !!sync['workvivo.apiKey'],
    aurorObserved: fresh('aurorbuddy.auror.jwt', 20 * 60_000),
    safeiqObserved: fresh('safetyagent.safepass.token', 6 * 60 * 60_000) };
}

export async function showDeviceReadiness() {
  let state = await deviceReadiness();
  if (state.reviewed) return;
  const panel = document.createElement('aside');
  panel.className = 'status-strip status-strip-info';
  panel.setAttribute('aria-label', 'This browser setup');
  const title = document.createElement('strong');
  title.textContent = 'Check access on this browser';
  const info = document.createElement('p');
  info.textContent = 'Your saved preferences can sync between PCs; website sign-ins do not. Open the tools you use and complete sign-in or MFA when prompted. Power BI, Tableau and Google reports still require your own access.';
  const status = document.createElement('p');
  status.setAttribute('aria-live', 'polite');
  const render = () => { status.textContent = `Auror: ${state.aurorObserved ? 'recent token observed' : 'not verified here'}. SafeIQ: ${state.safeiqObserved ? 'recent token observed' : 'not verified here'}. Workvivo API key: ${state.workvivoConfigured ? 'configured; connection not tested' : 'not configured - set it in Workvivo'}. These checks do not verify application permissions.`; };
  const check = document.createElement('button');
  check.className = 'btn btn-secondary'; check.textContent = 'Check again';
  check.addEventListener('click', async () => {
    check.disabled = true;
    try { state = await deviceReadiness(); render(); }
    catch { status.textContent = 'Could not check this browser. Try again.'; }
    finally { check.disabled = false; }
  });
  const dismiss = document.createElement('button');
  dismiss.className = 'btn btn-secondary'; dismiss.textContent = 'Dismiss on this browser';
  dismiss.addEventListener('click', async () => {
    try { await chrome.storage.local.set({ [REVIEWED_KEY]: Date.now() }); panel.remove(); }
    catch { status.textContent = 'Could not save dismissal. Try again.'; }
  });
  render(); panel.append(title, info, status, check, dismiss);
  // Keep the check visible when routing replaces the contents of <main>.
  const viewport = document.querySelector('.shell-viewport') || document.body;
  viewport.prepend(panel);
}
