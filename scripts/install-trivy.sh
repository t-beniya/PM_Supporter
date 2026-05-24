#!/usr/bin/env sh
set -eu

TRIVY_VERSION="${TRIVY_VERSION:-0.69.3}"
TRIVY_VERIFY_SIGNATURE="${TRIVY_VERIFY_SIGNATURE:-1}"

if [ "$(id -u)" = "0" ]; then
  default_install_dir="/usr/local/bin"
else
  default_install_dir="${HOME}/.local/bin"
fi

INSTALL_DIR="${TRIVY_INSTALL_DIR:-$default_install_dir}"

case "$(uname -s)" in
  Linux) os="Linux" ;;
  Darwin) os="macOS" ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="64bit" ;;
  aarch64|arm64) arch="ARM64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

archive="trivy_${TRIVY_VERSION}_${os}-${arch}.tar.gz"
url="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${archive}"
checksums_url="https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt"
sigstore_url="${url}.sigstore.json"

echo "Installing Trivy v${TRIVY_VERSION} from ${url}"
curl -fsSL "$url" -o "$tmp_dir/$archive"
curl -fsSL "$checksums_url" -o "$tmp_dir/checksums.txt"
grep "  ${archive}$" "$tmp_dir/checksums.txt" > "$tmp_dir/checksum.txt"
(cd "$tmp_dir" && sha256sum -c checksum.txt)

if [ "$TRIVY_VERIFY_SIGNATURE" != "0" ]; then
  if ! command -v cosign >/dev/null 2>&1; then
    echo "cosign is required to verify Trivy's Sigstore signature." >&2
    echo "Run ./scripts/install-cosign.sh first, or set TRIVY_VERIFY_SIGNATURE=0 to skip signature verification." >&2
    exit 127
  fi

  curl -fsSL "$sigstore_url" -o "$tmp_dir/${archive}.sigstore.json"
  if ! cosign verify-blob-attestation "$tmp_dir/$archive" \
    --bundle "$tmp_dir/${archive}.sigstore.json" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --certificate-identity "https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v${TRIVY_VERSION}"; then
    echo "Trivy release bundle is not an attestation; verifying it as a signed blob instead."
    cosign verify-blob "$tmp_dir/$archive" \
      --bundle "$tmp_dir/${archive}.sigstore.json" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      --certificate-identity "https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v${TRIVY_VERSION}"
  fi
fi

tar -xzf "$tmp_dir/$archive" -C "$tmp_dir" trivy

if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR"
fi

install -m 0755 "$tmp_dir/trivy" "$INSTALL_DIR/trivy"
"$INSTALL_DIR/trivy" --version
