# syntax=docker/dockerfile:1
# This builds the actual image for Peacha

# ---- Stage 1: build the React SPA --------------------------------------------
FROM node:24-alpine AS web
WORKDIR /src/web
# Deps first, for layer caching. vite emits into ../server/dist (see vite.config).
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
# gen:crd (part of `npm run build`) reads the Calico CRD manifest at repo-root
# third_party/; bring just that file into the web stage.
COPY third_party/calico/manifests/v3_projectcalico_org.yaml /src/third_party/calico/manifests/v3_projectcalico_org.yaml
RUN npm run build
# -> /src/server/dist (index.html + assets)

# ---- Stage 2: build the static Go binary -------------------------------------
FROM golang:1.27 AS build
# Pure-Go build: cgo off selects felix's syscall stubs and drops the libbpf C
# dep (we only assemble eBPF programs, never make BPF syscalls). The resulting
# binary is fully static, so it runs on scratch. GOTOOLCHAIN=auto lets the
# go.mod `go` directive pull the exact toolchain if the image lags.
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
WORKDIR /src

# Version stamps for `editor --version`. Forwarded by `make image`/`publish`
# (the build context has no .git, so they can't be derived here); when omitted
# the binary falls back to its built-in defaults.
ARG EDITOR_VERSION=unknown
ARG ENGINE_VERSION=unknown
ARG CALICO_VERSION=unknown

# Module metadata first (better layer caching). The editor is a single module
# with all third-party replaces inlined in go.mod, so every checksum lives in
# the repo-root go.sum; the replaced source trees are copied below.
COPY go.mod go.sum ./
COPY third_party/ ./third_party/
COPY cmd/ ./cmd/
COPY server/ ./server/

# Embedded assets: the freshly built SPA lands in server/dist/ below. The other
# embed source dirs — server/baseline/ (committed snapshots), server/tutorials/
# (committed read-along tutorials), and server/exams/ (mirrored from exams/ by
# `make exams-sync`, which the image/publish targets run first) — already arrive
# with the `COPY server/` above. All must exist before `go build` so the
# //go:embed directives in server/{static,baseline,tutorials,exams}.go resolve.
COPY --from=web /src/server/dist/ ./server/dist/

# -trimpath strips local filesystem paths from the binary; -s -w drops the
# symbol + DWARF tables. Smaller binary, and no source paths leak into it.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath \
      -ldflags="-s -w -X main.editorVersion=${EDITOR_VERSION} -X main.engineVersion=${ENGINE_VERSION} -X main.calicoVersion=${CALICO_VERSION}" \
      -o /out/peacha ./cmd/editor

# ---- Stage 3: runtime --------------------------------------------------------
FROM scratch
# Run unprivileged (nobody). scratch has no /etc/passwd, but a numeric UID/GID
# needs none. The server only reads embedded data + listens on a socket, so it
# needs no writable filesystem.
USER 65534:65534
# Root CAs so outbound HTTPS (OAuth token/userinfo calls to slack.com et al.)
# can verify server certs; scratch ships none. The golang build stage (Debian)
# already has the bundle.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/peacha /peacha
EXPOSE 8080
ENTRYPOINT ["/peacha"]
CMD ["--addr", ":8080"]
