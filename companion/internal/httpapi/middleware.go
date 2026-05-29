package httpapi

import (
	"log/slog"
	"net"
	"net/http"
)

// withLoopbackOnly отклоняет запросы не с loopback-адреса. Сервер и так
// биндится на 127.0.0.1, но это явная defense-in-depth на случай мисконфига
// Addr.
func withLoopbackOnly(next http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			log.Warn("rejected non-loopback request", "remote", r.RemoteAddr)
			http.Error(w, "forbidden: loopback only", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withOriginAllowlist пропускает запрос, только если заголовок Origin входит
// в allowlist. Пустой allowlist = dev-режим: проверка отключена (предупреждение
// логируется один раз при сборке цепочки). Отсутствие Origin при непустом
// allowlist — отказ (расширение всегда шлёт Origin = chrome-extension://<id>).
func withOriginAllowlist(allowed []string, log *slog.Logger, next http.Handler) http.Handler {
	if len(allowed) == 0 {
		log.Warn("Origin allowlist пуст — проверка Origin отключена (dev-режим)")
		return next
	}
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[o] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if _, ok := set[origin]; !ok {
			log.Warn("rejected disallowed origin", "origin", origin)
			http.Error(w, "forbidden: origin not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
