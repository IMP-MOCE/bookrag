package llama

import "testing"

func TestAssetURLWindowsCUDA(t *testing.T) {
	u, err := AssetURL("windows", "amd64", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{releaseBase, ReleaseTag, "win-cuda", ".zip"} {
		if !contains(u, want) {
			t.Fatalf("url %q не содержит %q", u, want)
		}
	}
}

func TestAssetURLExplicitTag(t *testing.T) {
	u, err := AssetURL("windows", "amd64", "b9999")
	if err != nil {
		t.Fatal(err)
	}
	if !contains(u, "b9999") {
		t.Fatalf("url %q не содержит запрошенный тег", u)
	}
}

func TestAssetURLUnsupported(t *testing.T) {
	if _, err := AssetURL("linux", "amd64", ""); err == nil {
		t.Fatal("ожидалась ошибка: нет офиц. CUDA-пребилда для linux")
	}
	if _, err := AssetURL("windows", "arm64", ""); err == nil {
		t.Fatal("ожидалась ошибка: arm64 не поддержан в v1")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
