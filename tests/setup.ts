// Заглушки browser API для unit-тестов в jsdom.
// Дополняются в конкретных тестах через Object.assign(globalThis.chrome, ...).

import "fake-indexeddb/auto";

const chromeStub = {
  runtime: {
    sendMessage: () => Promise.resolve({ ok: false, code: "test_env" }),
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
};

if (!("chrome" in globalThis)) {
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
}
