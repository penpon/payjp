import { checkSession, SessionCheckError, startOAuth } from './api.js';
import { renderState } from './ui.js';

async function init(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  renderState(app, 'loading', startOAuth);

  try {
    const session = await checkSession();
    renderState(app, session.linked ? 'linked' : 'not_linked', startOAuth);
  } catch (err) {
    if (err instanceof SessionCheckError && err.status === 401) {
      renderState(app, 'not_linked', startOAuth);
    } else {
      console.error('[init] Session check failed:', err);
      renderState(app, 'error', startOAuth);
    }
  }
}

init();
