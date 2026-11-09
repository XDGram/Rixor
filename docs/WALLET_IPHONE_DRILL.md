# Mobile-wallet signing drill: Zerion Wallet on iPhone, with Windows Command Prompt (CMD)

**Status (9 Nov 2026):**
- This drill has **not yet been run on a physical iPhone**. Every step marked **[DEVICE TEST]** below is unconfirmed.
- The **physical Ledger drill** (`docs/LEDGER_WINDOWS_CMD.md` §3) is **also still untested** on a real device.
- This drill does **not** change the testnet signing requirements. Real Safe signatures still follow
  `docs/TESTNET_DEPLOYMENT.md` and `docs/LEDGER_WINDOWS_CMD.md` (`safe-tx.mjs` with `cast … --ledger`). Using a phone
  wallet for real Safe signatures would be a separate decision with its own review.

What the drill proves: Zerion on your iPhone can produce the exact kind of signature a Safe needs (EIP-712
`eth_signTypedData_v4` over a Safe v1.5.0 `SafeTx`) for the address you expect, and it passes the same strict checks as
`safe-tx.mjs check`.

What keeps it harmless:
- The drill data is the published Ledger drill, byte for byte. Its SHA-256 is
  `489faedae00cff6af2e32a71275c01cb34a0f98ce49069860f655023a4356e53`. It is bound to local chain **31337** and the
  dummy contract `0x000000000000000000000000000000000000dEaD`, so the signature is valid on no network and for no Safe.
- The "network" is a local Anvil chain on your PC. It listens on 127.0.0.1 only and has no accounts or keys.
- The station passes only read requests to it. Every method that sends, signs or changes state is refused, including
  `eth_sendRawTransaction` and `eth_sendTransaction`. Nothing is broadcast anywhere.
- The station checks the signature on your PC. It never shows, logs or saves it, and the page never displays it.
- Nobody ever types, shares or photographs a recovery phrase, passphrase or private key. No step needs one.

## 0. One-time setup on the PC

Requirements:
- 64-bit Intel/AMD Windows.
- Node.js 20.17 or newer, and Git.
- An iPhone with Zerion Wallet, on the **same Wi-Fi** as the PC. If the Wi-Fi is a guest network that blocks devices
  from seeing each other, connect the PC to the iPhone's Personal Hotspot instead.

Get the project at the reviewed commit the operator gives you. Use a new folder:
```cmd
git clone https://github.com/XDGram/Rixor.git Rixor-wallet-drill
cd Rixor-wallet-drill
git checkout <reviewed commit hash from the operator>
npx -y npm@11.21.2 ci
git rev-parse HEAD
```
- `git rev-parse HEAD` must print the reviewed commit.
- Use `npx -y npm@11.21.2 ci`, not plain `npm ci`. npm 10, which comes with Node 20 and 22, refuses this lockfile with
  `EBADPLATFORM` (a macOS-only package bundled inside `ganache` is not marked optional). npm 11 installs it unchanged.

## 1. Start the drill station on the PC

1. In Zerion, copy or read your wallet address. On the PC, type it in place of `0xYOUR_ADDRESS`:
   ```cmd
   node scripts\wallet-drill.mjs --expect 0xYOUR_ADDRESS
   ```
2. The first time, **Windows Firewall** asks about Node.js. Allow it on **Private networks** only. If your Wi-Fi is set
   to "Public", change it to Private in Windows Settings → Network & internet → Wi-Fi → your network.
3. The station prints:
   - the drill SHA-256 and both hashes;
   - for each network address of this PC, a **Network RPC URL** and a **Page** URL, like
     `http://192.168.1.23:8787/<32 random characters>/rpc` and `http://192.168.1.23:8787/<same characters>/`.

   Use the address of the Wi-Fi (or hotspot) adapter. `ipconfig` shows it under "Wireless LAN adapter Wi-Fi",
   "IPv4 Address".
4. Leave this window open. It shows what the phone does: RPC requests (with the address they came from), the Stage 1
   report and the Stage 2 result. The station stops after 60 minutes or with **Ctrl+C**. The random part of the URL
   changes on every start.

If port 8787 is busy, add `--port 8788` and use the new URLs.

## 2. Add the drill network in Zerion (iPhone)

[DEVICE TEST] Menu names vary between Zerion versions.

1. Open Zerion → **Settings** → **Networks**. Alternatively, use the network selector ("All Networks") →
   **Available networks**.
2. Choose **Add network manually** (or "Add custom network") and enter:
   - Network name: `Rixor Drill (local)`
   - RPC URL: the **Network RPC URL** from the station, typed exactly
   - Chain ID: `31337`
   - Currency symbol: `ETH`
   - Block explorer: leave empty
3. Save, then select **Rixor Drill (local)** as the active network.
4. If iOS asks "Zerion would like to find and connect to devices on your local network", choose **Allow**. If you
   declined earlier, turn it on in iPhone Settings → Privacy & Security → Local Network → Zerion.

The station window should now show lines such as `rpc first eth_chainId from 192.168.1.40`. The address shows who is
talking to the station:
- an address on your Wi-Fi, such as `192.168.…` or `10.…`, is your iPhone;
- if Zerion can save the network but nothing appears, Zerion is not contacting your PC from the phone. Report that.

## 3. Stage 1: connect and check the network (no signing)

1. In Zerion, open the **Browser** tab, type the **Page** URL exactly (it starts with `http://`), and open it.
2. Tap **Run Stage 1** and approve the connection request in Zerion.
3. The page lists each step:
   - which wallet it found;
   - whether an account was received;
   - the wallet's chain ID;
   - if it isn't 31337, whether Zerion accepted a request to switch to, or add, the drill network. Approve only a
     network named **Rixor Drill (local)** with chain ID **31337** and the station's RPC URL.
   - whether the wallet could read the drill chain;
   - whether the account matches the address you typed on the PC.
4. **Stage 1 PASS** enables Stage 2. If it isn't passed, fix what the page says, for example select the drill network
   or the right account, and tap **Run Stage 1** again.

Nothing is signed in Stage 1.

## 4. Stage 2: sign the drill

1. Read the table on the page. It lists exactly what the drill contains.
2. Tap **Sign the drill**. Zerion opens a signing request.
3. **[DEVICE TEST]** Compare Zerion's screen with the page. Approve only if all of these match:
   - network: Rixor Drill (local), chain ID 31337;
   - verifying contract: `0x000000000000000000000000000000000000dEaD`;
   - type `SafeTx`, with to: `0x000000000000000000000000000000000000dEaD`;
   - value `0`, data `0x`, operation `0`;
   - safeTxGas, baseGas and gasPrice `0`;
   - gasToken and refundReceiver: the zero address `0x0000000000000000000000000000000000000000`;
   - nonce `0`.

   If Zerion shows hashes instead of fields, they must be domain hash
   `0xb1d7214fcc497f10f1d3856096eb3488620f3bf807fbce3d2b736a6d60644130` and message hash
   `0xb55a82e23ac7c0476cc3abb0ad7a160811c811401e1db2f8a9f00e787db9cc22`.

   If Zerion shows only a summary you cannot check, or anything differs, **reject** and write down exactly what it
   showed. Rejecting is a valid drill result.
4. After you approve, the page shows **PASS** or **FAIL** and the reason. The station window shows:
   ```
   stage 2 check from 192.168.…:
   {
     "result": "PASS",
     "matchesExpected": true,
     ...
   }
   ```
   The checks are the same as `safe-tx.mjs check`: exactly 65 bytes, v = 27 or 28, and EIP-712 recovery to the
   address you typed.
   - A personal-message (EIP-191) signature, a signature for another chain or contract, or a different account →
     **FAIL**.
   - v = 0/1, or a smart-contract account signature → **FAIL**. These checks are never relaxed.

## 5. Finish

1. Press **Ctrl+C** in the station window. Anvil stops with it.
2. In Zerion, delete the **Rixor Drill (local)** network and switch back to your usual network.
3. Optionally delete the `Rixor-wallet-drill` folder.

## 6. Report back

Send only the following. **Do not send your address or the signature.**
1. iPhone model, iOS version and Zerion version.
2. Node version, and whether `npx -y npm@11.21.2 ci` succeeded.
3. Whether adding the custom network worked, and any warning about the `http://` RPC URL.
4. Whether iOS asked for Local Network access.
5. Whether the station showed `rpc first …` lines, and whether they came from the iPhone's local address.
6. The Stage 1 steps as listed on the page (or as printed in the station window).
7. What Zerion's signing screen showed, in order: fields or hashes, labels, and any warning or security banner.
8. The Stage 2 result: PASS/FAIL, the reason, and `matchesExpected` from the station window.
9. Any error message, copied exactly.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `EBADPLATFORM` during install | Plain `npm ci` (npm 10). Use `npx -y npm@11.21.2 ci`. |
| `cannot start Anvil` | Dependencies not installed in this folder, or not 64-bit Windows. Re-run the install. |
| Zerion cannot save the network or reach the RPC URL | Phone on a different Wi-Fi, a guest network that isolates devices, the firewall blocked Node on a "Public" network, Local Network access denied, or Zerion does not accept `http://` local RPC URLs [DEVICE TEST]. Check each, then report. |
| Station shows no `rpc` lines at all | The phone never reached the PC: same causes as above. |
| Page does not open in Zerion's browser | Type the full `http://` Page URL, including the random part and the final `/`. Report if Zerion refuses `http://` pages [DEVICE TEST]. |
| "No wallet found" | The page was opened in Safari, not in Zerion's Browser tab. |
| Account does NOT match | Select the account whose address you typed on the PC, or restart the station with the right `--expect`. |
| Stage 2 FAIL "v byte is 0/1" or "recovers to a different address" | Zerion returned a signature in a format a Safe cannot use, or signed with another account or method. Report it; do not change the checks. |
| `rpc REFUSED` lines | Something asked to send or change state. It was refused and nothing was broadcast. Report the method names. |

## 8. For reviewers: what was verified without a phone

`node scripts/test-wallet-drill.mjs` (local only, throwaway in-memory keys, loopback Anvil). It checks that:
- the station serves the published drill byte for byte, with the pinned values shared with
  `scripts/test-safe-signing.mjs` and the Ledger guide;
- signatures from ethers and from Cast (identical) pass;
- another key, an EIP-191 signature, v = 0/1, a truncated or non-hex signature, a missing signature and a signature for
  chain 46630 all fail;
- the RPC refuses `eth_sendRawTransaction`, `eth_sendTransaction`, signing and node-control methods, and batches
  containing them, and the chain state is unchanged afterwards;
- wrong URL paths return 404, and the page is served with a strict Content-Security-Policy;
- the page requests only connect/read/network methods plus `eth_signTypedData_v4`;
- the station's output never contains a signature, a private key or Anvil's test mnemonic;
- Anvil stops with the station.

The page flow was also exercised once in headless Chromium at iPhone size with a scripted test wallet: wrong chain,
switch refused, network added through the station's RPC, Stage 1 PASS, and a signed drill giving Stage 2 PASS. A real
Zerion app has not been tested.

The station adds new files only (`scripts/wallet-drill.mjs`, `scripts/wallet-drill/`, `scripts/lib/wallet-drill-core.mjs`,
`scripts/test-wallet-drill.mjs`, this guide). It runs the unchanged `safe-tx.mjs drill` and uses `signatureProblem`
and `typedProblems` from the unchanged `scripts/lib/safe-typed.mjs`.
