// MV3 service worker может выгружаться через ~30 секунд бездействия. Пока крутится анализ,
// нам нужно его удерживать. Простейший рабочий приём — короткий периодический alarm.

const ALARM_NAME = "bookrag.keepalive";
const PERIOD_MIN = 0.5; // 30 секунд — минимум, разрешённый chrome.alarms.

export function startKeepAlive(): void {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  // Не плодить, если уже есть.
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (existing) return;
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MIN });
  });
}

export function stopKeepAlive(): void {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  chrome.alarms.clear(ALARM_NAME);
}

// Обработчик нужно зарегистрировать один раз; сам он ничего не делает —
// факт срабатывания alarm пробуждает SW и тем самым продлевает его жизнь.
export function attachKeepAliveListener(): void {
  if (typeof chrome === "undefined" || !chrome.alarms?.onAlarm) return;
  chrome.alarms.onAlarm.addListener(() => {
    /* пинг, чтобы SW не выгружался */
  });
}
