{
  const report = (message) => window.__TAURI__.core.invoke('report', { message }).catch(() => {});
  window.addEventListener('error', (event) => {
    report(`failed: ${event.error?.stack ?? event.message ?? `could not load ${event.target?.src}`}`);
  }, true);
  window.addEventListener('unhandledrejection', (event) => report(`failed: ${event.reason?.stack ?? event.reason}`));
}
