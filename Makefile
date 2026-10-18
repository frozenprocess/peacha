# Peacha - editor build targets.
#
#   make submodules    fetch the third_party/ submodules (engine + Calico)
#   make dev           run vite + go server side-by-side, hot-reload UI
#                      (stores default to SQLite files in CWD; set RESULTS_FILE
#                       and SHARE_FILE to postgres:// DSNs for PostgreSQL)
#   make dev-auth      like dev, with OAuth login enabled from .env.auth
#   make build         build the SPA + the Go binary (single artifact)
#   make build-go      just the Go binary (uses whatever's in server/dist)
#   make build-web     just the SPA (emits into server/dist)
#   make crd-sync      suggest policy-schema updates from the vendored Calico CRD
#   make test          go test (editor module only)
#   make image         docker build (deploy/Dockerfile) tagged :dev
#   make publish       build the deployable scratch image + tag IMAGE:TAG
#                      (no source / no keys in the image; build + tag only)
#   make pull-db       download every SQLite db from the k8s deployment
#   make pull-links-db download share-links.db from the k8s deployment
#                      (into PULL_DIR=./k8s-db; uses current KUBECONFIG)
#   make clean         drop server/dist content (keeps .placeholder) + bin
#   make distclean     also de-init the submodules and drop go.work.sum

# This repo IS the build root: the editor module lives at the top level and the
# engine + Calico source are vendored as git submodules under third_party/. The
# committed go.work (Module + ./third_party/telepathy + ./third_party/calico)
# stitches all three together, so plain `go build` from here resolves everything.
REPO_ROOT := $(CURDIR)
BIN       := $(REPO_ROOT)/bin/editor

# The engine package renders eBPF policy programs via felix/bpf/polprog, which
# transitively imports the cgo libbpf package (needs libbpf C headers). We only
# assemble programs in-process - never make BPF syscalls - so we build with cgo
# off, selecting felix's pure-Go syscall stubs and dropping the libbpf build
# dep. Evaluate / iptables / nftables are pure Go.
GO        := CGO_ENABLED=0 go
MODULE    := github.com/frozenprocess/peacha
DIST      := server/dist
# The provider snapshots + seed topology are committed directly under
# server/baseline/ so go:embed picks them up - see server/baseline.go. The
# server discovers providers from the <provider>_<plugin>-snapshot.json
# filename prefixes there.

# Submodules: third_party/calico/go.mod is the marker that the checkout exists.
# `git submodule update --init` fetches both from the URLs in .gitmodules.
SUBMODULE_MARKER := third_party/calico/go.mod

# Image coordinates for `make publish` (and `make image`). Override on the CLI:
#   make publish IMAGE=ghcr.io/acme/peacha-editor TAG=v1.2.3
IMAGE ?= ghcr.io/frozenprocess/peacha-editor
TAG   ?= $(shell git -C $(REPO_ROOT) rev-parse --short HEAD 2>/dev/null || echo latest)

# Docker images exclude private exams unless explicitly requested.
INCLUDE_EXAMS ?= false

# Local OAuth credentials file sourced by `make dev-auth` (gitignored). Override
# the path on the CLI: make dev-auth AUTH_ENV=deploy/my-auth.env
AUTH_ENV ?= .env.auth
# Where `make pull-links-db` drops the db pulled from the k8s deployment. Kept
# out of the repo root so it never clobbers the local dev share-links.db.
PULL_DIR ?= ./k8s-db

# The graded exams (answer keys included) live in a PRIVATE repo so they never
# ship in this public checkout. `make exams-sync` pulls them into
# third_party/exams (gitignored, like the rest of third_party/) at build time.
# No access / repo absent -> build with 0 exams and server/exams/README.md
# explains how to author them. Override to point at a fork:
#   make exams-sync EXAMS_REPO=git@github.com:you/your-exams.git
EXAMS_REPO ?= git@github.com:frozenprocess/peacha-networkpolicy-exams.git
EXAMS_DIR  := $(REPO_ROOT)/third_party/exams

# Which upstream projectcalico/calico ref the third_party/calico submodule is
# checked out to. Defaults to the branch pinned in .gitmodules. Override on the
# CLI to build against another branch/tag/commit, then run `make submodules`
# to actually switch the checkout:
#   make submodules CALICO_BRANCH=master && make build
# NOTE: switching the ref alone is not enough to build. Calico's own go.mod
# replace directives are not transitive, so this repo's go.mod mirrors them by
# hand (see the replace block at the bottom of go.mod). After switching you MUST
# re-sync that block to match third_party/calico/go.mod or the build will fail.
CALICO_BRANCH ?= release-v3.33

# Which frozenprocess/telepathy ref the third_party/telepathy submodule is
# checked out to. Telepathy has no branch pin in .gitmodules, so this defaults
# to its remote default branch. Override on the CLI, then run `make submodules`
# to actually switch the checkout:
#   make submodules TELEPATHY_BRANCH=main && make build
TELEPATHY_BRANCH ?= v0.2.0

# Component versions stamped into the binary (editor --version). The editor
# value is this repo's `git describe`; engine + Calico come from their submodule
# checkouts. `make image`/`publish` forward these as Docker build args (the
# build context has no .git, so they can't be derived inside the image). e7ee15aaaa
# Override any on the CLI: make build EDITOR_VERSION=v1.2.3
EDITOR_VERSION ?= $(shell git -C $(REPO_ROOT) describe --tags --always --dirty 2>/dev/null || echo dev)
ENGINE_VERSION ?= $(shell git -C $(REPO_ROOT)/third_party/telepathy describe --tags --always --dirty 2>/dev/null || echo unknown)
CALICO_VERSION ?= $(shell git -C $(REPO_ROOT)/third_party/calico describe --tags --always --dirty 2>/dev/null || echo $(CALICO_BRANCH))
VERSION_LDFLAGS := -X main.editorVersion=$(EDITOR_VERSION) -X main.engineVersion=$(ENGINE_VERSION) -X main.calicoVersion=$(CALICO_VERSION)



.PHONY: help submodules dev dev-auth build build-go build-web exams-sync crd-sync test image publish pull-db pull-links-db clean distclean

.DEFAULT_GOAL := help

# `make` with no target prints this list. Keep in sync with the header comment.
help:
	@echo "Peacha - editor build targets:"
	@echo ""
	@echo "  make submodules    fetch the third_party/ submodules (engine + Calico)"
	@echo "                     (checks out CALICO_BRANCH=$(CALICO_BRANCH) + TELEPATHY_BRANCH=$(TELEPATHY_BRANCH))"
	@echo "  make dev           run vite + go server side-by-side, hot-reload UI"
	@echo "                     (RESULTS_FILE / SHARE_FILE override the SQLite defaults)"
	@echo "  make dev-auth      like dev, with OAuth login enabled from $(AUTH_ENV)"
	@echo "  make build         build the SPA + the Go binary (single artifact)"
	@echo "  make build-go      just the Go binary (uses whatever's in server/dist)"
	@echo "  make build-web     just the SPA (emits into server/dist)"
	@echo "  make exams-sync    mirror exams/ into the embed source dir"
	@echo "  make crd-sync      suggest policy-schema updates from the vendored Calico CRD"
	@echo "  make test          go test (editor module only)"
	@echo "  make image         docker build (deploy/Dockerfile) tagged :dev"
	@echo "  make publish       build the deployable scratch image + tag IMAGE:TAG"
	@echo "  make pull-db       download every SQLite db from the k8s deployment into $(PULL_DIR)"
	@echo "  make pull-links-db download share-links.db from the k8s deployment into $(PULL_DIR)"
	@echo "  make clean         drop server/dist content (keeps .placeholder) + bin"
	@echo "  make distclean     also de-init the submodules and drop go.work.sum"

# --- Submodules ------------------------------------------------------------
# Initialise/refresh the engine + Calico checkouts under third_party/. The
# marker rule makes this a no-op once the trees are present, so build targets
# can depend on it cheaply.
$(SUBMODULE_MARKER):
	@echo ">> initialising submodules (third_party/telepathy + third_party/calico)"
	git submodule update --init --recursive

# Fetch + check both submodules out to their configured refs. This IS a
# network-touching, submodule-mutating target - run it explicitly. Build
# targets depend on $(SUBMODULE_MARKER) (init-only), never on this, so a plain
# `make build` uses whatever's checked out and never touches the network.
#   make submodules CALICO_BRANCH=master TELEPATHY_BRANCH=main
# After switching CALICO_BRANCH you MUST re-sync go.mod's mirrored replace block
# to match third_party/calico/go.mod (see the note by CALICO_BRANCH) or the
# build will not resolve.
submodules: $(SUBMODULE_MARKER)
	@echo ">> switching third_party/calico to '$(CALICO_BRANCH)'"
	git -C third_party/calico fetch origin $(CALICO_BRANCH)
	git -C third_party/calico checkout $(CALICO_BRANCH)
	git -C third_party/calico reset --hard FETCH_HEAD
	@echo ">> switching third_party/telepathy to '$(TELEPATHY_BRANCH)'"
	git -C third_party/telepathy fetch origin $(TELEPATHY_BRANCH)
	git -C third_party/telepathy checkout $(TELEPATHY_BRANCH)
	git -C third_party/telepathy reset --hard FETCH_HEAD
	@echo "!! if you changed CALICO_BRANCH, re-sync go.mod's replace block to match third_party/calico/go.mod before building"

dev: $(SUBMODULE_MARKER)
	@command -v node >/dev/null || (echo "node not installed - see README" && exit 1)
	@echo "starting go server on :8080 and vite on :5173 (Ctrl-C to stop both)"
	( cd web && npm install --silent && npm run dev ) & \
	  $(GO) run -ldflags "$(VERSION_LDFLAGS)" ./cmd/editor --addr :8080 ; \
	  kill 0

# Same as `make dev`, but with OAuth login enabled. Sources $(AUTH_ENV) (a
# gitignored KEY=value file - copy .env.auth.example) and exports it so the
# editor picks up credentials through the --slack-*/--google-*/--github-* flags'
# env fallbacks. Pin AUTH_BASE_URL=http://localhost:5173 in that file so OAuth
# callbacks resolve back through the vite proxy. GitHub/Google allow an
# http://localhost redirect URI; Slack needs an https tunnel.
dev-auth: $(SUBMODULE_MARKER)
	@command -v node >/dev/null || (echo "node not installed - see README" && exit 1)
	@[ -f $(AUTH_ENV) ] || (echo "missing $(AUTH_ENV) - copy .env.auth.example and fill in your OAuth app credentials" && exit 1)
	@echo "starting go server on :8080 (OAuth enabled from $(AUTH_ENV)) and vite on :5173 (Ctrl-C to stop both)"
	set -a; . ./$(AUTH_ENV); set +a; \
	  ( cd web && npm install --silent && npm run dev ) & \
	  $(GO) run -ldflags "$(VERSION_LDFLAGS)" ./cmd/editor --addr :8080 ; \
	  kill 0

build: $(SUBMODULE_MARKER) build-web build-go

build-go: $(SUBMODULE_MARKER)
	@mkdir -p $(DIST) && touch $(DIST)/.placeholder # //go:embed all:dist needs >=1 file
	$(GO) build -ldflags "$(VERSION_LDFLAGS)" -o $(BIN) ./cmd/editor
	@echo "built $(BIN)"

# Pull the private exams repo into third_party/exams (gitignored, so exams never
# land in a public checkout) then mirror the exam dirs into the //go:embed dir so
# exams.go can embed them. The answer keys live in each exam's meta.json and are
# only read server-side - never served to the client. If the repo can't be
# reached (public clone, no access), the build still succeeds with 0 exams;
# server/exams/README.md is the template that documents how to author them.
exams-sync::
	@if [ -d $(EXAMS_DIR)/.git ]; then \
	  git -C $(EXAMS_DIR) pull --ff-only 2>/dev/null || echo ">> exams pull skipped (offline?) - using cached exams/"; \
	else \
	  git clone --depth 1 $(EXAMS_REPO) $(EXAMS_DIR) 2>/dev/null \
	    || echo ">> no access to $(EXAMS_REPO) - building with 0 exams (see server/exams/README.md)"; \
	fi
	@mkdir -p server/exams
	@find server/exams -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
	@[ -d $(EXAMS_DIR) ] && find $(EXAMS_DIR) -mindepth 1 -maxdepth 1 -type d ! -name .git -exec cp -r {} server/exams/ \; 2>/dev/null || true
	@echo "synced server/exams ($$(find server/exams -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') exams)"

build-web:
	@command -v node >/dev/null || (echo "node not installed - see README" && exit 1)
	cd web && npm install --silent && npm run build
	@touch $(DIST)/.placeholder # vite's emptyOutDir wipes it
	@echo "built SPA into $(DIST)"

# Diff the editor's hand-curated policy schemas against the vendored Calico CRD
# (third_party/calico/manifests/v3_projectcalico_org.yaml) and print paste-ready
# TS snippets for any field/enum upstream added that we don't model yet. Advisory
# only - it never edits web/src/policySchemas.ts; you review and apply, keeping
# descriptions / additionalProperties / intentional divergences human-curated.
# Run this after bumping the Calico submodule. The CI gate is `npm run check:crd`.
crd-sync: $(SUBMODULE_MARKER)
	@command -v node >/dev/null || (echo "node not installed - see README" && exit 1)
	cd web && npm run --silent crd-sync

test: $(SUBMODULE_MARKER)
	$(GO) test $(MODULE)/...

image: $(SUBMODULE_MARKER)
	docker build -f deploy/Dockerfile \
	  --build-arg EDITOR_VERSION=$(EDITOR_VERSION) \
	  --build-arg ENGINE_VERSION=$(ENGINE_VERSION) \
	  --build-arg CALICO_VERSION=$(CALICO_VERSION) \
	  --build-arg INCLUDE_EXAMS=$(INCLUDE_EXAMS) \
	  -t $(IMAGE):dev .

# Build the deployable image and tag it locally. The Dockerfile is multi-stage:
# the SPA + Go binary are built in throwaway stages and the final stage is
# `scratch` holding only the static binary - no source tree, toolchain, or keys
# land in the final image. Private exam data is opt-in.
# Build + tag only; push when ready:
#   docker push $(IMAGE):$(TAG)
publish: $(SUBMODULE_MARKER)
	docker build -f deploy/Dockerfile \
	  --build-arg EDITOR_VERSION=$(EDITOR_VERSION) \
	  --build-arg ENGINE_VERSION=$(ENGINE_VERSION) \
	  --build-arg CALICO_VERSION=$(CALICO_VERSION) \
	  --build-arg INCLUDE_EXAMS=$(INCLUDE_EXAMS) \
	  -t $(IMAGE):$(TAG) .
	@echo "tagged $(IMAGE):$(TAG) (scratch). push with: docker push $(IMAGE):$(TAG)"

# Download the SQLite stores (+ their WAL sidecars) from the running k8s
# deployment: pull-db grabs every *.db on the PVC, pull-links-db just the
# short-link store. The image is scratch (no tar), so deploy/k8s/pull-db.sh mounts the
# PVC read-only in a throwaway busybox pod instead of using `kubectl cp`.
#   KUBECONFIG=~/.kube/config-ovh make pull-db PULL_DIR=./backup
pull-db:
	deploy/k8s/pull-db.sh all $(PULL_DIR)

pull-links-db:
	deploy/k8s/pull-db.sh share-links.db $(PULL_DIR)

clean:
	rm -f $(BIN)
	@mkdir -p $(DIST) server/exams
	find $(DIST) -mindepth 1 -maxdepth 1 ! -name .placeholder -exec rm -rf {} +
	@touch $(DIST)/.placeholder
	find server/exams -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +

distclean: clean
	git submodule deinit -f third_party/telepathy third_party/calico 2>/dev/null || true
	rm -f go.work.sum
