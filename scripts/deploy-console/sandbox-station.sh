#!/usr/bin/env bash
# Deploy Console station in a temporary cloud sandbox (e.g. Vercel Sandbox). See docs/DEPLOY_CONSOLE.md.
# Nothing here holds a key or signs: the phone wallet signs. Two phases, with the sandbox's outbound network switched to
# deny-all in between.
#
# Phase 1, setup (outbound allowed ONLY to: github.com, codeload.github.com, registry.npmjs.org,
#   binaries.soliditylang.org, and for setup-testnet also rpc.testnet.chain.robinhood.com):
#     bash sandbox-station.sh setup-rehearsal <commit> <deployer>
#         rehearsal bundle (local chain 31337, real deployer, placeholder Safe signers)
#     bash sandbox-station.sh setup-testnet <commit> <created-at> <gas-price-wei> <deployer> <O1,O2,O3> <G1,G2,G3>
#         regenerates the REVIEWED testnet bundle reproducibly: same commit + addresses + created-at + gas price
#         => the same bundle hash as the reviewed one (compare it before using the console)
# (operator: switch outbound to deny-all and verify)
# Phase 2, start (no outbound network):
#     bash sandbox-station.sh start <https-public-origin>
#         rehearsal bundle: console + local chain + RPC relay; testnet bundle: console + bundle only (serve-only)
set -euo pipefail
WORK="${STATION_WORK:-/vercel/rixor-console}"
cmd="${1:-}"

clone_and_install() {
  local commit="$1"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be a full 40-character hash"; exit 1; }
  mkdir -p "$WORK" && cd "$WORK"
  [ -d repo ] || git clone --quiet https://github.com/XDGram/Rixor.git repo
  cd repo
  git -c advice.detachedHead=false checkout --quiet "$commit"
  git submodule update --init --quiet lib/forge-std
  [ "$(git rev-parse HEAD)" = "$commit" ] || { echo "checkout mismatch"; exit 1; }
  npx -y npm@11.21.2 ci --no-audit --no-fund
}

case "$cmd" in
  setup-rehearsal)
    commit="${2:?commit}"; deployer="${3:?deployer address}"
    [[ "$deployer" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "invalid deployer address"; exit 1; }
    clone_and_install "$commit"
    RH_TESTNET_RPC_URL=http://127.0.0.1:1 node scripts/export-deploy-bundle.mjs --rehearsal --deployer "$deployer" --out "$WORK/bundle.json"
    npm run -s build:deploy-console
    echo "SETUP_DONE rehearsal commit $commit"
    ;;
  setup-testnet)
    commit="${2:?commit}"; created="${3:?created-at}"; gas="${4:?gas price}"; deployer="${5:?deployer}"; owners="${6:?O1,O2,O3}"; guardians="${7:?G1,G2,G3}"
    clone_and_install "$commit"
    RIXOR_DEPLOYER="$deployer" RIXOR_OWNER_SIGNERS="$owners" RIXOR_GUARDIAN_SIGNERS="$guardians" \
      node scripts/export-deploy-bundle.mjs --created-at "$created" --gas-price "$gas" --out "$WORK/bundle.json" | grep -E '"bundleHash"|"final"|"startNonce"|selfCheck'
    npm run -s build:deploy-console
    echo "SETUP_DONE testnet commit $commit"
    ;;
  start)
    origin="${2:?https public origin}"
    cd "$WORK/repo"
    setsid nohup node scripts/deploy-console/station.mjs --bundle "$WORK/bundle.json" --dist dist-console \
      --public-url "$origin" --port 8788 --host 0.0.0.0 --minutes 40 > "$WORK/station.log" 2>&1 < /dev/null &
    for _ in $(seq 1 120); do grep -q STATION_READY "$WORK/station.log" 2>/dev/null && break; sleep 0.5; done
    head -20 "$WORK/station.log"
    ;;
  *)
    echo "usage: $0 setup-rehearsal <commit> <deployer> | setup-testnet <commit> <created-at> <gas-wei> <D> <O1,O2,O3> <G1,G2,G3> | start <https-origin>"; exit 1 ;;
esac
