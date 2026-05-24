#!/usr/bin/env sh
set -eu

COSIGN_VERSION="${COSIGN_VERSION:-3.0.6}"

if [ "$(id -u)" = "0" ]; then
  default_install_dir="/usr/local/bin"
else
  default_install_dir="${HOME}/.local/bin"
fi

INSTALL_DIR="${COSIGN_INSTALL_DIR:-$default_install_dir}"

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

binary="cosign-${os}-${arch}"
url="https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/${binary}"
checksums_url="https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign_checksums.txt"

echo "Installing Cosign v${COSIGN_VERSION} from ${url}"
curl -fsSL "$url" -o "$tmp_dir/$binary"
curl -fsSL "$checksums_url" -o "$tmp_dir/checksums.txt"
grep "  ${binary}$" "$tmp_dir/checksums.txt" > "$tmp_dir/checksum.txt"
(cd "$tmp_dir" && sha256sum -c checksum.txt)
chmod 0755 "$tmp_dir/$binary"

if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR"
fi

install -m 0755 "$tmp_dir/$binary" "$INSTALL_DIR/cosign"
"$INSTALL_DIR/cosign" version
