// Loads the service worker module graph with a no-op chrome stub. Catches
// top-level crashes (bad imports, undefined constants) without a browser.

function stub() {
  const fn = () => undefined;
  return new Proxy(fn, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      return stub();
    },
    apply: () => undefined,
  });
}

globalThis.chrome = stub();

try {
  await import('../extension/src/background.js');
  console.log('ok   background module graph evaluated');
} catch (error) {
  console.error(`FAIL background module: ${error.message}`);
  process.exitCode = 1;
}
