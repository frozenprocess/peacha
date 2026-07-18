package server

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// TestResultsStore exercises the SQLite pass store: a recorded pass is readable
// back, a duplicate (sub, exam) doesn't create a second row, distinct exams and
// users are kept separate, and a disabled store (empty path) is a safe no-op.
func TestResultsStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "results.db")
	r := newResults(path, 0) // 0 = keep forever, so retention can't perturb the assertions
	if r.db == nil {
		t.Fatal("newResults: db is nil for a valid path")
	}

	rec := PassRecord{Sub: "slack:U1", Provider: "slack", Exam: "deny-egress", ExamTitle: "Deny egress"}
	if err := r.record(rec); err != nil {
		t.Fatalf("record: %v", err)
	}
	// Re-pass the same exam (title refreshed) - must NOT add a second row.
	rec.ExamTitle = "Deny egress v2"
	if err := r.record(rec); err != nil {
		t.Fatalf("record (re-pass): %v", err)
	}
	// A different exam for the same user, and another user's pass.
	if err := r.record(PassRecord{Sub: "slack:U1", Exam: "allow-dns"}); err != nil {
		t.Fatalf("record (2nd exam): %v", err)
	}
	if err := r.record(PassRecord{Sub: "slack:U2", Exam: "deny-egress"}); err != nil {
		t.Fatalf("record (other user): %v", err)
	}

	if got, want := r.passedBy("slack:U1"), []string{"allow-dns", "deny-egress"}; !reflect.DeepEqual(got, want) {
		t.Errorf("passedBy(U1) = %v, want %v", got, want)
	}
	if got, want := r.passedBy("slack:U2"), []string{"deny-egress"}; !reflect.DeepEqual(got, want) {
		t.Errorf("passedBy(U2) = %v, want %v", got, want)
	}
	if got := r.passedBy("nobody"); got != nil {
		t.Errorf("passedBy(unknown) = %v, want nil", got)
	}

	// Disabled store: empty path → record errors, passedBy is empty.
	d := newResults("", 0)
	if err := d.record(rec); err == nil {
		t.Error("disabled store: record should error")
	}
	if got := d.passedBy("slack:U1"); got != nil {
		t.Errorf("disabled store: passedBy = %v, want nil", got)
	}
}

// TestResultsRetentionAndForget exercises the GDPR primitives: a retention
// window purges records past their age, and forget() erases a subject outright.
func TestResultsRetentionAndForget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "results.db")
	r := newResults(path, 30)
	if got := r.retentionDays(); got != 30 {
		t.Fatalf("retentionDays = %d, want 30", got)
	}

	// A fresh pass is inside the window and survives.
	if err := r.record(PassRecord{Sub: "github:1", Exam: "a"}); err != nil {
		t.Fatalf("record: %v", err)
	}
	// Seed a row stamped 60 days ago (bypassing record's now-stamp) - it's past
	// the 30-day window and must be purged.
	old := time.Now().Add(-60 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := r.db.Exec(`INSERT INTO passes (sub, exam, passed_at) VALUES (?, ?, ?);`, "github:1", "stale", old); err != nil {
		t.Fatalf("seed stale row: %v", err)
	}
	if n, err := r.purgeExpired(); err != nil || n != 1 {
		t.Fatalf("purgeExpired = %d, %v; want 1, nil", n, err)
	}
	if got, want := r.passedBy("github:1"), []string{"a"}; !reflect.DeepEqual(got, want) {
		t.Errorf("after purge passedBy = %v, want %v", got, want)
	}

	// Erasure removes everything for the subject and reports the row count.
	n, err := r.forget("github:1")
	if err != nil {
		t.Fatalf("forget: %v", err)
	}
	if n != 1 {
		t.Errorf("forget deleted %d rows, want 1", n)
	}
	if got := r.passedBy("github:1"); got != nil {
		t.Errorf("after forget passedBy = %v, want nil", got)
	}

	// A retention of 0 keeps records forever (retentionDays reports 0, purge is a no-op).
	if got := newResults(filepath.Join(t.TempDir(), "r2.db"), 0).retentionDays(); got != 0 {
		t.Errorf("retentionDays(0) = %d, want 0", got)
	}
}
