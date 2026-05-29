package tray

import (
	"context"
	"testing"
	"time"
)

func TestStatusString(t *testing.T) {
	cases := map[Status]string{
		StatusUnknown:     "unknown",
		StatusIdle:        "idle",
		StatusDownloading: "downloading",
		StatusLoading:     "loading",
		StatusReady:       "ready",
		StatusError:       "error",
	}
	for s, want := range cases {
		if got := s.String(); got != want {
			t.Errorf("Status(%d).String() = %q, want %q", s, got, want)
		}
	}
}

func TestTooltipFor(t *testing.T) {
	tests := []struct {
		name    string
		version string
		upd     Update
		want    string
	}{
		{"version+detail", "v0.1.0", Update{Status: StatusReady, Detail: "bookrag-4b"},
			"BookRAG Companion v0.1.0 — ready: bookrag-4b"},
		{"no version", "", Update{Status: StatusIdle},
			"BookRAG Companion — idle"},
		{"version no detail", "v0.1.0", Update{Status: StatusLoading},
			"BookRAG Companion v0.1.0 — loading"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := TooltipFor(tc.version, tc.upd); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNoopRunStopUnblocks(t *testing.T) {
	c := NewNoop()
	done := make(chan struct{})
	go func() {
		c.Run(context.Background())
		close(done)
	}()

	// Run должен висеть, пока не Stop().
	select {
	case <-done:
		t.Fatal("Run завершился до Stop()")
	case <-time.After(20 * time.Millisecond):
	}

	c.Stop()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run не разблокировался после Stop()")
	}

	// Идемпотентность Stop.
	c.Stop()
}

func TestNoopRunCtxUnblocks(t *testing.T) {
	c := NewNoop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run не разблокировался по ctx")
	}
}

func TestNoopSetStatusStoresLast(t *testing.T) {
	c := NewNoop()
	c.SetStatus(StatusDownloading, "12 MB / 100 MB")
	c.SetStatus(StatusReady, "bookrag-4b")
	got := c.Last()
	if got.Status != StatusReady || got.Detail != "bookrag-4b" {
		t.Fatalf("last = %+v, want ready/bookrag-4b", got)
	}
}
