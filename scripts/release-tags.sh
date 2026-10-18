#!/usr/bin/env bash
set -euo pipefail
# Run after fetching all origin branches and tags, inside the serialized publisher.
image=${IMAGE:?IMAGE is required}
ref=${GITHUB_REF:?GITHUB_REF is required}
sha=${GITHUB_SHA:?GITHUB_SHA is required}
echo "$image:sha-$sha"
if [[ "$ref" == refs/heads/main ]]; then
  if [[ "$sha" == "$(git rev-parse origin/main)" ]]; then
    echo "$image:dev"
  fi
elif [[ "$ref" == refs/tags/* ]]; then
  tag=${ref#refs/tags/}
  # Deliberately support stable versions and SemVer prereleases, not build metadata.
  if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?$ ]]; then
    echo "Unsupported release tag: $tag" >&2
    exit 1
  fi
  [[ ${#tag} -le 128 ]] || { echo 'Release tag is too long' >&2; exit 1; }
  if [[ "$tag" == *-* ]]; then
    IFS=. read -ra identifiers <<< "${tag#*-}"
    for identifier in "${identifiers[@]}"; do
      if [[ "$identifier" =~ ^[0-9]+$ && "$identifier" =~ ^0[0-9]+$ ]]; then
        echo "Numeric prerelease identifiers cannot have leading zeros" >&2
        exit 1
      fi
    done
  fi
  echo "$image:$tag"
  if [[ "$tag" != *-* ]]; then
    newest=$(git tag -l | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V | tail -1)
    [[ "$tag" != "$newest" ]] || echo "$image:latest"
  fi
fi
