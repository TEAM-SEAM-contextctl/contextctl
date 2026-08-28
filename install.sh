#!/usr/bin/env bash
#
# contextctl installer.
#
# Downloads the published package tarballs and hands them to npm in one
# command. It deliberately does very little: npm resolves and links, and
# `contextctl install-assets` fetches and verifies the embedding model. A shell
# script that reimplemented either would be a second implementation of something
# already checked by digest, and it would drift.
#
#   curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash -s -- --version v1.1.0
#
set -euo pipefail

REPO="TEAM-SEAM-contextctl/contextctl"
RELEASE_TAG=""
RELEASE_BASE=""
REQUESTED_RELEASE_TAG=""
LOCALE=""
MINIMUM_NODE_VERSION="24.18.0"
SUPPORTED_NODE_MAJOR=24
MINIMUM_NODE_MINOR=18
MAXIMUM_NODE_MAJOR=25
SUPPORTED_NODE_RANGE=">=24.18.0 <25"

# Order is irrelevant — every tarball is passed to a single `npm i -g`, which
# resolves the workspace dependencies among them without consulting a registry.
PACKAGES=(
  contextctl-contracts
  contextctl-selection-delivery
  contextctl-registry-lifecycle
  contextctl-ingestion-indexing
  contextctl-daemon
)

WORK_DIR=""
cleanup() {
  if [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' "$*" >&2; }

localized() {
  local korean="$1" english="$2" format
  shift 2
  if [ "${LOCALE}" = "ko" ]; then
    format="${korean}"
  else
    format="${english}"
  fi
  printf "${format}\n" "$@"
}

say_i18n() { localized "$@"; }
fail_i18n() { localized "$@" >&2; }

resolve_locale() {
  local candidate
  if [ "${CONTEXTCTL_LOCALE+x}" = "x" ]; then
    case "${CONTEXTCTL_LOCALE}" in
      en|ko) LOCALE="${CONTEXTCTL_LOCALE}" ;;
      *)
        fail "[locale_invalid] CONTEXTCTL_LOCALE must be en or ko."
        exit 2
        ;;
    esac
    return
  fi

  candidate="${LC_ALL-}"
  [ -n "${candidate}" ] || candidate="${LC_MESSAGES-}"
  [ -n "${candidate}" ] || candidate="${LANG-}"
  case "${candidate}" in
    ko|ko[_-]*|KO|KO[_-]*) LOCALE="ko" ;;
    *) LOCALE="en" ;;
  esac
}

usage() {
  say_i18n "사용법: install.sh [--version <vX.Y.Z>]" "Usage: install.sh [--version <vX.Y.Z>]"
  say ""
  say_i18n \
    "버전을 생략하면 GitHub의 최신 정식 릴리스를 설치합니다." \
    "If you omit the version, the latest stable GitHub release is installed."
}

parse_arguments() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        if [ "$#" -lt 2 ]; then
          fail_i18n \
            "--version 뒤에 릴리스 태그가 필요합니다." \
            "--version requires a release tag."
          exit 2
        fi
        REQUESTED_RELEASE_TAG="$2"
        shift 2
        ;;
      --version=*)
        REQUESTED_RELEASE_TAG="${1#--version=}"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail_i18n "알 수 없는 설치 옵션입니다: %s" "Unknown installer option: %s" "$1"
        fail_i18n \
          "install.sh --help 로 사용법을 확인하세요." \
          "Run install.sh --help for usage."
        exit 2
        ;;
    esac
  done
}

validate_release_tag() {
  if [[ ! "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail_i18n \
      "릴리스 버전은 vX.Y.Z 형식이어야 합니다: %s" \
      "The release version must use the vX.Y.Z form: %s" \
      "$1"
    exit 2
  fi
}

resolve_release() {
  if [ -n "${REQUESTED_RELEASE_TAG}" ]; then
    RELEASE_TAG="${REQUESTED_RELEASE_TAG}"
  else
    local resolved_url
    if ! resolved_url="$(curl -fsSL --retry 2 --connect-timeout 20 -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"; then
      fail_i18n \
        "최신 릴리스 버전을 확인하지 못했습니다." \
        "Could not resolve the latest release version."
      fail_i18n \
        "릴리스 목록: https://github.com/%s/releases" \
        "Releases: https://github.com/%s/releases" \
        "${REPO}"
      exit 1
    fi
    RELEASE_TAG="${resolved_url##*/}"
  fi
  validate_release_tag "${RELEASE_TAG}"
  RELEASE_BASE="${CONTEXTCTL_INSTALL_RELEASE_BASE:-https://github.com/${REPO}/releases/download/${RELEASE_TAG}}"
  say_i18n "릴리스 %s 를 설치합니다." "Installing release %s." "${RELEASE_TAG}"
}

# --------------------------------------------------------------------- node

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail_i18n "Node.js 를 찾을 수 없습니다." "Node.js was not found."
    fail ""
    fail_i18n \
      "contextctl 은 Node.js %s 범위를 지원합니다." \
      "contextctl supports Node.js %s." \
      "${SUPPORTED_NODE_RANGE}"
    fail_i18n \
      "배포 tarball과 네이티브 런타임을 이 범위에서 검증했습니다." \
      "The release tarballs and native runtime are verified in this range."
    fail ""
    fail_i18n "설치: https://nodejs.org/en/download" "Install Node.js: https://nodejs.org/en/download"
    # Deliberately not installed for you. A version manager rewrites shell
    # startup files and changes which Node every other project on this machine
    # sees; that is a decision for whoever owns the machine, not for an
    # installer they piped into bash.
    exit 1
  fi

  local version
  version="$(node --version)"

  if ! node_version_supported "${version}"; then
    fail_i18n \
      "Node.js %s 이 활성 상태입니다. 지원 범위는 %s입니다." \
      "Node.js %s is active. The supported range is %s." \
      "${version}" "${SUPPORTED_NODE_RANGE}"
    fail ""
    fail_i18n \
      "필수 릴리스 검사는 Node %s에서 수행되며 Node 25 이상은 아직 검증하지 않았습니다." \
      "Required release checks run on Node %s; Node 25 and later are not verified." \
      "${MINIMUM_NODE_VERSION}"
    fail ""
    fail_i18n \
      "Node %s 범위로 전환한 뒤 다시 실행하십시오: https://nodejs.org/en/download" \
      "Switch to Node %s, then run the installer again: https://nodejs.org/en/download" \
      "${SUPPORTED_NODE_RANGE}"
    exit 1
  fi

  say_i18n "Node.js %s 을 씁니다." "Using Node.js %s." "${version}"
}

# npm의 engines 경계(>=24.18.0 <25)와 같은 판정입니다. npm은 기본값으로
# engines 불일치를 경고만 하고 설치를 계속할 수 있으므로, 설치기가 먼저
# 닫힌 실패해야 사용자가 비검증 런타임에 설치됐다고 오해하지 않습니다.
node_version_supported() {
  local version core major remainder minor patch
  version="$1"
  core="${version#v}"
  major="${core%%.*}"
  remainder="${core#*.}"
  if [ "${remainder}" = "${core}" ]; then
    return 1
  fi
  minor="${remainder%%.*}"
  patch="${remainder#*.}"
  if [ "${patch}" = "${remainder}" ]; then
    return 1
  fi
  if [ -z "${major}" ] || [ -z "${minor}" ] || [ -z "${patch}" ]; then
    return 1
  fi
  case "${major}:${minor}:${patch}" in
    *[!0-9:]*) return 1 ;;
  esac
  [ "${major}" -eq "${SUPPORTED_NODE_MAJOR}" ] &&
    [ "${major}" -lt "${MAXIMUM_NODE_MAJOR}" ] &&
    [ "${minor}" -ge "${MINIMUM_NODE_MINOR}" ]
}

require_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    fail_i18n \
      "npm 을 찾을 수 없습니다. Node.js 설치에 npm 이 포함돼 있어야 합니다." \
      "npm was not found. Your Node.js installation must include npm."
    exit 1
  fi
}

require_download_tools() {
  if ! command -v curl >/dev/null 2>&1; then
    fail_i18n \
      "curl 을 찾을 수 없습니다. 릴리스 자산을 내려받는 데 필요합니다." \
      "curl was not found. It is required to download release assets."
    exit 1
  fi
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail_i18n \
      "SHA-256 검증 도구를 찾을 수 없습니다(sha256sum 또는 shasum 필요)." \
      "No SHA-256 tool was found (sha256sum or shasum is required)."
    exit 1
  fi
}

# ----------------------------------------------------------------- download

download_packages() {
  WORK_DIR="$(mktemp -d)"
  say_i18n \
    "패키지와 SHA-256 목록을 내려받습니다..." \
    "Downloading packages and the SHA-256 manifest..."
  local checksums_url name url expected actual
  checksums_url="${RELEASE_BASE}/SHA256SUMS"
  if ! curl -fsSL --retry 2 --connect-timeout 20 -o "${WORK_DIR}/SHA256SUMS" "${checksums_url}"; then
    fail_i18n \
      "검증 목록을 내려받지 못했습니다: %s" \
      "Could not download the checksum manifest: %s" \
      "${checksums_url}"
    fail_i18n \
      "검증 목록이 없는 릴리스는 설치하지 않습니다." \
      "A release without a checksum manifest will not be installed."
    exit 1
  fi
  for name in "${PACKAGES[@]}"; do
    url="${RELEASE_BASE}/${name}.tgz"
    if ! curl -fsSL --retry 2 --connect-timeout 20 -o "${WORK_DIR}/${name}.tgz" "${url}"; then
      fail_i18n "내려받기에 실패했습니다: %s" "Download failed: %s" "${url}"
      fail ""
      fail_i18n \
        "릴리스가 아직 게시되지 않았거나 네트워크가 막혀 있을 수 있습니다." \
        "The release may not be published yet, or the network may be blocked."
      fail_i18n \
        "릴리스 목록: https://github.com/%s/releases" \
        "Releases: https://github.com/%s/releases" \
        "${REPO}"
      exit 1
    fi
    expected="$(expected_digest "${name}.tgz")" || {
      fail_i18n \
        "SHA256SUMS에 %s.tgz 항목이 정확히 하나 있어야 합니다." \
        "SHA256SUMS must contain exactly one entry for %s.tgz." \
        "${name}"
      exit 1
    }
    actual="$(compute_sha256 "${WORK_DIR}/${name}.tgz")"
    if [ "${actual}" != "${expected}" ]; then
      fail_i18n \
        "SHA-256 검증에 실패했습니다: %s.tgz" \
        "SHA-256 verification failed: %s.tgz" \
        "${name}"
      fail_i18n "  기대: %s" "  Expected: %s" "${expected}"
      fail_i18n "  실제: %s" "  Actual: %s" "${actual}"
      fail_i18n \
        "npm 설치를 시작하지 않았습니다." \
        "The npm installation was not started."
      exit 1
    fi
    say "  ${name}.tgz  ${actual}"
  done
}

expected_digest() {
  local filename="$1"
  awk -v expected_file="${filename}" '
    {
      file = $2
      sub(/^\*/, "", file)
      if (file == expected_file) {
        count += 1
        digest = tolower($1)
      }
    }
    END {
      if (count != 1 || length(digest) != 64 || digest ~ /[^0-9a-f]/) exit 1
      print digest
    }
  ' "${WORK_DIR}/SHA256SUMS"
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print tolower($1) }'
  else
    shasum -a 256 "$1" | awk '{ print tolower($1) }'
  fi
}

# ------------------------------------------------------------------ install

install_packages() {
  say_i18n "설치합니다..." "Installing packages..."
  local tarballs=()
  local name
  for name in "${PACKAGES[@]}"; do
    tarballs+=("${WORK_DIR}/${name}.tgz")
  done

  # One command, all five. Installed separately, npm would try to resolve each
  # package's `@contextctl/*` dependencies from the registry, where they do not
  # exist.
  if ! npm install -g "${tarballs[@]}"; then
    fail_i18n "npm 설치에 실패했습니다." "The npm installation failed."
    exit 1
  fi
}

# ------------------------------------------------------- reachability on PATH

# Where npm actually put the command, for when the shell cannot find it.
global_bin_dir() {
  local prefix
  if prefix="$(npm prefix -g 2>/dev/null)"; then
    printf '%s\n' "${prefix}/bin"
  fi
}

# A version manager keeps one bin directory per installed Node, so a command
# installed under the active version is invisible from every other one — and
# from a login shell that activates a different default. This is the failure
# this check exists for; it has been hit on a real machine.
version_manager_hint() {
  local node_path
  node_path="$(command -v node)"
  case "${node_path}:${FNM_DIR-}:${NVM_DIR-}:${ASDF_DIR-}${ASDF_DATA_DIR-}" in
    *fnm*) printf 'fnm\n' ;;
    *nvm*) printf 'nvm\n' ;;
    *asdf*) printf 'asdf\n' ;;
    *) printf '\n' ;;
  esac
}

verify_reachable() {
  if command -v contextctl >/dev/null 2>&1; then
    local command_path actual_version actual_display expected_version
    command_path="$(command -v contextctl)"
    expected_version="contextctl ${RELEASE_TAG#v}"
    if actual_version="$(contextctl --version 2>/dev/null)" && [ "${actual_version}" = "${expected_version}" ]; then
      say ""
      say_i18n \
        "설치를 마쳤습니다: %s (%s)" \
        "Installation complete: %s (%s)" \
        "${command_path}" "${actual_version}"
      return 0
    fi

    fail ""
    fail_i18n \
      "PATH의 contextctl 이 요청한 릴리스와 다릅니다." \
      "The contextctl command on PATH does not match the requested release."
    fail_i18n "  경로: %s" "  Path: %s" "${command_path}"
    fail_i18n "  기대: %s" "  Expected: %s" "${expected_version}"
    actual_display="${actual_version}"
    if [ -z "${actual_display}" ]; then
      if [ "${LOCALE}" = "ko" ]; then
        actual_display="실행 실패"
      else
        actual_display="execution failed"
      fi
    fi
    fail_i18n \
      "  실제: %s" \
      "  Actual: %s" \
      "${actual_display}"
    fail_i18n \
      "활성 Node 버전과 npm 전역 bin 경로를 확인한 뒤 다시 실행하십시오." \
      "Check the active Node version and npm global bin path, then run the installer again."
    return 1
  fi

  local bin_dir manager
  bin_dir="$(global_bin_dir)"
  manager="$(version_manager_hint)"

  fail ""
  fail_i18n \
    "설치는 끝났지만 셸이 contextctl 을 찾지 못합니다." \
    "The package was installed, but the shell cannot find contextctl."
  if [ -n "${bin_dir}" ]; then
    fail_i18n "설치된 위치: %s/contextctl" "Installed at: %s/contextctl" "${bin_dir}"
  fi
  if [ -n "${manager}" ]; then
    fail ""
    fail_i18n \
      "%s 을(를) 쓰고 계십니다. 버전 매니저는 활성 Node 버전의 bin 에만 설치합니다." \
      "You are using %s. Version managers install only into the active Node version bin directory." \
      "${manager}"
    fail_i18n \
      "즉 지금 활성인 %s 에만 깔려 있고, 다른 버전으로 전환하면 사라진 것처럼 보입니다." \
      "It is installed only for the active %s runtime and may appear to vanish after switching versions." \
      "$(node --version)"
    fail_i18n \
      "새 셸에서 같은 버전을 활성화하거나, 아래 경로를 PATH 에 추가하십시오." \
      "Activate the same version in a new shell, or add the path below to PATH."
  fi
  if [ -n "${bin_dir}" ]; then
    fail ""
    fail "  export PATH=\"${bin_dir}:\$PATH\""
  fi
  # Non-zero: the package is on disk, but an installer that cannot produce a
  # runnable command has not finished the job it was asked to do.
  return 1
}

# --------------------------------------------------------------- next steps

next_steps() {
  say ""
  say_i18n "다음 단계:" "Next steps:"
  say_i18n \
    "  1. contextctl install-assets   임베딩 모델 설치 (396.1 MiB, 약 415 MB, 동의를 묻습니다)" \
    "  1. contextctl install-assets   Install the embedding model (396.1 MiB, about 415 MB; asks for consent)"
  say_i18n \
    "  2. contextctl doctor           설치 상태 점검" \
    "  2. contextctl doctor           Check the installation"
  say_i18n \
    "  3. contextctl demo init        데모 문서 5개를 새 디렉터리에 준비" \
    "  3. contextctl demo init        Create five demo documents in a new directory"
  say ""
  say_i18n \
    "설치된 경로를 보려면: contextctl paths" \
    "To show installed paths: contextctl paths"
  # `install-assets` is not run here. It downloads 396.1 MiB (about 415 MB), and consent obtained
  # for "install the tool" is not consent for that; the subcommand asks on its
  # own, which it cannot do from inside a pipe.
}

main() {
  resolve_locale
  parse_arguments "$@"
  require_node
  require_npm
  require_download_tools
  resolve_release
  download_packages
  install_packages
  verify_reachable
  next_steps
}

main "$@"
