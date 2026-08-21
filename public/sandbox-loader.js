(() => {
  let reported = false;
  const describe = value => {
    if (value instanceof Error) return value.stack || value.message;
    if (value && typeof value === 'object' && 'message' in value) return String(value.message);
    return String(value || 'Unknown sandbox startup error.');
  };
  const report = value => {
    if (reported) return;
    reported = true;
    parent.postMessage({
      channel: 'harness-shell-v1',
      type: 'boot-error',
      error: describe(value),
    }, '*');
  };

  addEventListener('error', event => report(event.error || event.message || 'Sandbox module could not be loaded.'), true);
  addEventListener('unhandledrejection', event => report(event.reason));
})();
