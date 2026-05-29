package llama

import "fmt"

// ReleaseTag — запиненная версия llama.cpp. Берём прибитый пребилд из
// официальных GitHub-релизов ggml-org/llama.cpp (не вендорим в репозиторий,
// не собираем). Обновляется осознанно при апгрейде.
//
// llama.cpp тегирует релизы номером сборки, напр. "b4585".
const ReleaseTag = "b4585"

const releaseBase = "https://github.com/ggml-org/llama.cpp/releases/download"

// AssetURL возвращает URL прибитого CUDA-пребилда llama-server под платформу.
//
// v1 — только Windows x64 + CUDA (целевое железо: NVIDIA). Официальные релизы
// стабильно публикуют win-cuda; готового linux-cuda пребилда там нет —
// для Linux путь к бинарю задаётся вручную (BinaryPath), см. README.
func AssetURL(goos, goarch, tag string) (string, error) {
	if tag == "" {
		tag = ReleaseTag
	}
	if goarch != "amd64" {
		return "", fmt.Errorf("llama: неподдерживаемая архитектура %q (v1: только amd64)", goarch)
	}
	switch goos {
	case "windows":
		// Имя ассета у llama.cpp: llama-<tag>-bin-win-cuda-cu<ver>-x64.zip.
		// Версию CUDA фиксируем под прибитый релиз.
		name := fmt.Sprintf("llama-%s-bin-win-cuda-cu12.4-x64.zip", tag)
		return fmt.Sprintf("%s/%s/%s", releaseBase, tag, name), nil
	default:
		return "", fmt.Errorf(
			"llama: нет официального CUDA-пребилда для %s; укажите BinaryPath вручную", goos)
	}
}
