#!/bin/sh
# Pinned document tools shared by the workspace image and disposable test box.
install_document_tools() {
  case "$(uname -m)" in
    x86_64)
      pandoc_arch=amd64
      pandoc_hash=5def6e1ff535e397becce292ee97767a947306150b9fb1488003b67ac3417c5e
      typst_arch=x86_64
      typst_hash=7d214bfeffc2e585dc422d1a09d2b144969421281e8c7f5d784b65fc69b5673f ;;
    aarch64)
      pandoc_arch=arm64
      pandoc_hash=ad5cf63fe0420388d9ec513f02d03e061477b786d11a328164dce8ad7387b8bd
      typst_arch=aarch64
      typst_hash=4f5b7ee6e57fb639019ee0f6bffcf940edad228ede6ff5269a9f05a1544ceed4 ;;
    *) echo "unsupported document-tools architecture: $(uname -m)" >&2; return 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-${pandoc_arch}.tar.gz" -o "$tmp/pandoc.tar.gz" || return 1
  echo "$pandoc_hash  $tmp/pandoc.tar.gz" | sha256sum -c - || return 1
  tar -xzf "$tmp/pandoc.tar.gz" -C /usr/local/bin --strip-components=2 pandoc-3.6.4/bin/pandoc || return 1
  curl -fsSL "https://github.com/typst/typst/releases/download/v0.13.1/typst-${typst_arch}-unknown-linux-musl.tar.xz" -o "$tmp/typst.tar.xz" || return 1
  echo "$typst_hash  $tmp/typst.tar.xz" | sha256sum -c - || return 1
  tar -xJf "$tmp/typst.tar.xz" -C /usr/local/bin --strip-components=1 "typst-${typst_arch}-unknown-linux-musl/typst" || return 1
  rm -rf "$tmp"
}
