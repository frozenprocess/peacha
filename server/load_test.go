package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// quietEngine silences the engine's per-evaluation logrus chatter (Felix's calc
// graph logs at info on every build) so the latency table the load tests print
// isn't buried. Returns a restore func for the deferred reset.
func quietEngine() func() {
	prev := logrus.GetLevel()
	logrus.SetLevel(logrus.PanicLevel)
	return func() { logrus.SetLevel(prev) }
}

// loadExam picks a bundled exam that ships a solution and returns it together
// with that solution split into PolicyInputs exactly as the SPA would submit
// them (see splitSolutionPolicies). Skips the calling test if no such exam is
// loaded so the load tests don't fail in a tree without `make exams-sync`.
func loadGradePayload(tb testing.TB, h *Handler) (*Exam, []byte) {
	tb.Helper()
	for i := range h.exams {
		ex := &h.exams[i]
		if ex.Solution == "" {
			continue
		}
		policies := splitSolutionPolicies(ex.Solution)
		if len(policies) == 0 {
			continue
		}
		body, err := json.Marshal(GradeRequest{Policies: policies})
		if err != nil {
			tb.Fatalf("marshal grade request: %v", err)
		}
		return ex, body
	}
	tb.Skip("no bundled exam with a solution - run `make exams-sync`")
	return nil, nil
}

// percentile returns the p-th percentile (0..100) of a sorted duration slice
// using nearest-rank. Caller must pass a slice already sorted ascending.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int((p/100)*float64(len(sorted)-1) + 0.5)
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}

// TestEvaluateLatencyUnderLoad drives the real HTTP server (h.Routes via
// httptest.Server) with a bundled exam's reference solution, firing a fixed
// number of grade requests at increasing concurrency levels. The grade path
// runs engine.Evaluate under h.mu with no cache in front (unlike /v1/evaluate),
// so this measures exactly the serialised-engine behaviour: as concurrency
// climbs, throughput should plateau (one evaluation at a time) and tail latency
// should grow as requests queue on the mutex - not produce wrong results.
//
// It is a measurement harness, not a pass/fail gate: any non-200 response fails
// the test, but the latency table is reported via t.Logf (run with -v). Skipped
// under -short.
func TestEvaluateLatencyUnderLoad(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped under -short")
	}

	defer quietEngine()()

	h := NewHandler(Config{}) // auth disabled, no results store: the dev grade path
	ex, body := loadGradePayload(t, h)

	srv := httptest.NewServer(h.Routes())
	defer srv.Close()
	url := srv.URL + "/v1/exams/" + ex.Name + "/grade"

	// One request, reused by the helpers below. Returns the round-trip latency.
	doRequest := func() (time.Duration, error) {
		start := time.Now()
		resp, err := http.Post(url, "application/json", bytes.NewReader(body))
		if err != nil {
			return 0, err
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("status %d", resp.StatusCode)
		}
		return time.Since(start), nil
	}

	// Warm up: first call pays one-time init (topology build, etc.).
	if _, err := doRequest(); err != nil {
		t.Fatalf("warmup request failed: %v", err)
	}

	const totalPerLevel = 200
	concurrencies := []int{1, 2, 4, 8, 16}

	t.Logf("exam=%q requests/level=%d", ex.Name, totalPerLevel)
	t.Logf("%-6s %10s %10s %10s %10s %10s", "conc", "p50", "p95", "p99", "max", "req/s")

	for _, c := range concurrencies {
		lat := make([]time.Duration, totalPerLevel)
		var idx int64 = -1
		var failures int64

		var wg sync.WaitGroup
		wallStart := time.Now()
		for w := 0; w < c; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					i := atomic.AddInt64(&idx, 1)
					if i >= totalPerLevel {
						return
					}
					d, err := doRequest()
					if err != nil {
						atomic.AddInt64(&failures, 1)
						continue
					}
					lat[i] = d
				}
			}()
		}
		wg.Wait()
		wall := time.Since(wallStart)

		if failures > 0 {
			t.Errorf("concurrency=%d: %d request(s) failed", c, failures)
		}

		sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
		throughput := float64(totalPerLevel) / wall.Seconds()
		t.Logf("%-6d %10s %10s %10s %10s %10.1f",
			c,
			percentile(lat, 50).Round(time.Microsecond),
			percentile(lat, 95).Round(time.Microsecond),
			percentile(lat, 99).Round(time.Microsecond),
			lat[len(lat)-1].Round(time.Microsecond),
			throughput,
		)
	}
}

// BenchmarkEvaluateParallel is the `go test -bench` companion: it lets the Go
// benchmark framework scale GOMAXPROCS-worth of goroutines against the grade
// endpoint and report ns/op + allocs. Run e.g.:
//
//	go test ./server -run=^$ -bench=BenchmarkEvaluateParallel -benchmem -cpu=1,2,4,8
//
// Comparing -cpu values shows the serialisation ceiling directly: if the engine
// scaled, ns/op would fall as -cpu rises; because engine.Evaluate is serialised
// on h.mu, ns/op stays roughly flat past -cpu=1.
func BenchmarkEvaluateParallel(b *testing.B) {
	defer quietEngine()()

	h := NewHandler(Config{})
	ex, body := loadGradePayload(b, h)

	srv := httptest.NewServer(h.Routes())
	defer srv.Close()
	url := srv.URL + "/v1/exams/" + ex.Name + "/grade"

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			resp, err := http.Post(url, "application/json", bytes.NewReader(body))
			if err != nil {
				b.Error(err)
				return
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				b.Errorf("status %d", resp.StatusCode)
				return
			}
		}
	})
}
