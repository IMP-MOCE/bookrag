package main

import (
	"context"
	"testing"

	"github.com/bookrag/companion/internal/httpapi"
	"github.com/bookrag/companion/internal/tray"
)

type fakeCtrl struct{ st httpapi.ModelState }

func (f fakeCtrl) EnsureRunning(context.Context) error { return nil }
func (f fakeCtrl) Stop() error                         { return nil }
func (f fakeCtrl) Touch()                              {}
func (f fakeCtrl) State() httpapi.ModelState           { return f.st }

type fakeDL struct{ st httpapi.DownloadState }

func (f fakeDL) DownloadProgress() httpapi.DownloadState { return f.st }

func TestDeriveTrayStatus(t *testing.T) {
	tests := []struct {
		name       string
		ctrl       httpapi.ModelController
		dl         httpapi.DownloadReporter
		wantStatus tray.Status
		wantDetail string
	}{
		{
			name:       "nil/nil → idle",
			wantStatus: tray.StatusIdle,
		},
		{
			name:       "running ctrl → ready+modelId",
			ctrl:       fakeCtrl{st: httpapi.ModelState{Running: true, ModelID: "bookrag-4b"}},
			wantStatus: tray.StatusReady,
			wantDetail: "bookrag-4b",
		},
		{
			name:       "downloading с известным total → percent",
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "downloading", Done: 50, Total: 200}},
			wantStatus: tray.StatusDownloading,
			wantDetail: "25%",
		},
		{
			name:       "downloading без total → пусто",
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "downloading", Done: 50, Total: 0}},
			wantStatus: tray.StatusDownloading,
			wantDetail: "",
		},
		{
			name:       "verifying → loading + checksum",
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "verifying"}},
			wantStatus: tray.StatusLoading,
			wantDetail: "verifying checksum",
		},
		{
			name:       "download error → error",
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "error"}},
			wantStatus: tray.StatusError,
			wantDetail: "download failed",
		},
		{
			name:       "download приоритетнее ctrl running",
			ctrl:       fakeCtrl{st: httpapi.ModelState{Running: true, ModelID: "m"}},
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "downloading", Done: 10, Total: 100}},
			wantStatus: tray.StatusDownloading,
			wantDetail: "10%",
		},
		{
			name:       "download ready (нет phase) → ctrl решает",
			ctrl:       fakeCtrl{st: httpapi.ModelState{Running: false}},
			dl:         fakeDL{st: httpapi.DownloadState{Phase: "ready"}},
			wantStatus: tray.StatusIdle,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotStatus, gotDetail := deriveTrayStatus(tc.ctrl, tc.dl)
			if gotStatus != tc.wantStatus || gotDetail != tc.wantDetail {
				t.Errorf("got (%s,%q), want (%s,%q)",
					gotStatus, gotDetail, tc.wantStatus, tc.wantDetail)
			}
		})
	}
}

func TestParseOrigins(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{"chrome-extension://abc", []string{"chrome-extension://abc"}},
		{" chrome-extension://abc , chrome-extension://def ",
			[]string{"chrome-extension://abc", "chrome-extension://def"}},
		{",,,", nil},
	}
	for _, tc := range tests {
		got := parseOrigins(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("parseOrigins(%q): len %d, want %d (%v)", tc.in, len(got), len(tc.want), got)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("parseOrigins(%q)[%d] = %q, want %q",
					tc.in, i, got[i], tc.want[i])
			}
		}
	}
}

func TestBoolCount(t *testing.T) {
	if boolCount() != 0 {
		t.Errorf("empty → 0")
	}
	if boolCount(true, false, true) != 2 {
		t.Errorf("two true → 2")
	}
}

func TestMonitorTrayStatusExitsOnCtx(t *testing.T) {
	c := tray.NewNoop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		monitorTrayStatus(ctx, fakeCtrl{}, fakeDL{}, c)
		close(done)
	}()
	cancel()
	<-done // не должен зависнуть
	// последний SetStatus должен быть idle (нет загрузки/ctrl-running).
	if got := c.Last(); got.Status != tray.StatusIdle {
		t.Errorf("после ctx cancel last = %+v; want idle", got)
	}
}
