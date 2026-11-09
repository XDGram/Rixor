# Ledger address collection and signing drill: Windows Command Prompt (CMD)

For the six Safe signers (O1–O3, G1–G3) and the deployer (D). Nothing here sends a transaction or touches any
network's state. Nobody ever types, shares or photographs a recovery phrase, passphrase or private key: no step
needs one.

Labels:
- **[READ-ONLY]** creates nothing and signs nothing.
- **[CREATES FILE]** writes a local file.
- **[CREATES SIGNATURE]** the Ledger asks you to approve a signature.
- **[DEVICE TEST]** behaviour that could not be verified without a physical Ledger. Confirm it during the drill; if it
  differs, stop and report what the device showed.

Everything not marked **[DEVICE TEST]** was verified on 9 Nov 2026 from the Cast 1.7.1 source and binaries, the
Ledger Ethereum app source, and `npm run test:safe-signing`.

## 0. One-time setup

Requirements: 64-bit Intel/AMD Windows (Cast has no Windows-on-ARM build), Node.js 20 LTS or newer, Git, and a Ledger
running the Ethereum app 1.6.0 or newer (Cast refuses older versions for typed data).

[READ-ONLY] Must print `AMD64`:
```cmd
echo %PROCESSOR_ARCHITECTURE%
```

[CREATES FILE] Get the project at the reviewed commit the operator gives you (it creates a `Rixor` folder):
```cmd
git clone https://github.com/XDGram/Rixor.git
cd Rixor
git checkout <reviewed commit hash from the operator>
npm ci
```
`npm ci` installs the pinned packages and checks each download against `package-lock.json`. On Windows x64 it installs
`@foundry-rs/cast-win32-amd64@1.7.1`.

[READ-ONLY] Set the Cast path. Run this inside the `Rixor` folder, and again in every new CMD window:
```cmd
set "CAST=%CD%\node_modules\@foundry-rs\cast-win32-amd64\bin\cast.exe"
```

[READ-ONLY] Check the commit and the binary:
```cmd
git rev-parse HEAD
"%CAST%" --version
certutil -hashfile "%CAST%" SHA256
```
Expected:
- `git rev-parse HEAD` prints the reviewed commit the operator gave you.
- `--version` prints `cast Version: 1.7.1`.
- The SHA-256 is `b2541a63789931fc4c170e2502c16c3be259f2da4daba1a8d05ea5cfa7729baa`. This value is from the published
  npm package, whose integrity hash matches `package-lock.json`.

If anything differs, stop. Always call `"%CAST%"` directly; don't use `npx cast`, because the npm wrapper does not
pass on Cast's exit code.

## 1. Read your address (all seven slots)

Before each Cast command:
1. Connect and unlock the Ledger, then open the **Ethereum** app.
2. Close **Ledger Live** and any browser wallet. Cast needs the device to itself; its own error message says so.
3. If you use a Ledger passphrase (hidden wallet), stay in the same mode for every step. Never type the passphrase
   into the computer.

[READ-ONLY] This reads the public address only. Nothing is signed and nothing is sent:
```cmd
"%CAST%" wallet address --ledger --mnemonic-derivation-path "m/44'/60'/0'/0/0"
```
- Change only the third number for account index N: `"m/44'/60'/N'/0/0"`. This is Ledger Live's account N+1.
- Type the path **exactly**: plain double quotes around it, plain apostrophes inside.
- **Keep the leading `m/`.** Cast's Ledger code drops the first path element. Without `m/` it silently derives a
  different account, so the address will not match in step 2.

| Slot | Who | Device | Index |
|---|---|---|---|
| O1, O2, O3 | owner signers 1–3 | each their own Ledger | usually `0` |
| G1, G2, G3 | guardian signers 1–3 | each their own Ledger | usually `0` |
| D | operator (deployer) | operator's Ledger | an index used for nothing else; never a signer account |

All seven addresses must be different; the scripts refuse any overlap. Six separate people with six separate devices
are strongly recommended. The scripts can't tell when two accounts come from the same device.

[READ-ONLY] Optional: the account must have no code on testnet. This queries the network but sends nothing; it must
print `0x`:
```cmd
"%CAST%" code 0xYOUR_ADDRESS --rpc-url https://rpc.testnet.chain.robinhood.com
```

## 2. Verify the address in Ledger Live

[READ-ONLY] Showing an address does not sign or send anything.

1. Close the CMD window that was using the Ledger, then open Ledger Live.
2. Open the Ethereum account for index N, which is Ledger Live's account N+1. If it isn't listed, use
   **Add account → Ethereum**; this is local to Ledger Live.
3. **Receive** → choose that account → **verify the address on the device**. Compare **every character** on the
   Ledger screen with the Cast output. Approve on the device only if they match.
4. Only the address on the **Ledger screen** counts as proof.

[DEVICE TEST] Ledger Live menu names and where it shows the account's derivation path (e.g. account settings →
advanced) vary between versions. If you can't find the path, rely on the device-screen address match above.

## 3. Signing drill (valid on no network)

What the drill proves: your Ledger can make the exact kind of signature a Safe needs, for the address you reported.
The drill file is bound to local chain **31337** and the dummy contract `0x000000000000000000000000000000000000dEaD`,
so the signature is valid nowhere: not testnet, not mainnet, not any Safe.

### 3.1 What Cast and the Ledger actually do (verified)

- `cast wallet sign --data --from-file` signs **EIP-712 typed data**. It is not an EIP-191 personal message and not a
  raw hash.
- With `--ledger`, Cast computes two hashes on the computer and sends **only those two hashes** to the device:
  - the **domain hash** (binds the chain ID and the Safe address);
  - the **message hash** (binds the transaction fields).
- So the device shows only **"Domain hash"** and **"Message hash"**. It **cannot** show the chain ID, the contract
  address or any field. Your protection is comparing both hashes, character by character, with hashes your own
  computer recomputed from the file.
- The Ethereum app (1.12.0 and later) **refuses** this kind of signature unless **Blind signing** is enabled in its
  settings. It also shows a blind-signing warning before the hashes.

### 3.2 Steps

1. [CREATES FILE] Create the drill file `safe-signing-drill.json` (no network, no device):
   ```cmd
   node scripts\safe-tx.mjs drill
   ```

2. [READ-ONLY] Optional: check the file is byte-identical to the reviewed one. Expected:
   `489faedae00cff6af2e32a71275c01cb34a0f98ce49069860f655023a4356e53`
   ```cmd
   certutil -hashfile safe-signing-drill.json SHA256
   ```

3. [READ-ONLY] Recompute what the device must show (offline; also refuses a non-canonical file):
   ```cmd
   node scripts\safe-tx.mjs inspect --tx safe-signing-drill.json
   ```
   It must say `DRILL` and print:
   - Domain hash `0xb1d7214fcc497f10f1d3856096eb3488620f3bf807fbce3d2b736a6d60644130`
   - Message hash `0xb55a82e23ac7c0476cc3abb0ad7a160811c811401e1db2f8a9f00e787db9cc22`

4. On the Ledger, enable **Blind signing**: Ethereum app → Settings.

5. [CREATES SIGNATURE] Sign, with Ledger Live closed and the **same index** as your address:
   ```cmd
   "%CAST%" wallet sign --ledger --mnemonic-derivation-path "m/44'/60'/0'/0/0" --data --from-file safe-signing-drill.json
   ```
   **On the device** (verified content; [DEVICE TEST] for exact wording, order and formatting):
   - A blind-signing warning for a typed message.
   - **Domain hash** equal to `0xb1d7214f…60644130`. Compare all 64 hex characters with step 3.
   - **Message hash** equal to `0xb55a82e2…7db9cc22`. Compare all 64 hex characters.
   - Approve only if both match exactly (upper/lower case does not matter). Otherwise reject.

   If the device shows a "blind signing" error and Cast fails, Blind signing is off: do step 4 and repeat. Cast
   prints a signature: `0x` followed by 130 hex characters.

6. On the Ledger, **disable Blind signing** again.

7. [READ-ONLY] Check the signature (offline):
   ```cmd
   node scripts\safe-tx.mjs check --tx safe-signing-drill.json --sig 0xSIGNATURE --expect 0xYOUR_ADDRESS
   echo %ERRORLEVEL%
   ```
   Must print `"matchesExpected": true` and then `0`. `check` uses EIP-712 recovery, the same method Cast used. It
   refuses an EIP-191 signature, a changed file, or a malformed signature (wrong length, or v not 27/28). Anything
   else: wrong index or wrong device, so stop.

8. [CREATES FILE: deletes one] Optional clean-up (the file is already excluded from Git):
   ```cmd
   del safe-signing-drill.json
   ```

## 4. Report back

Send only the following:
- your slot, address and index;
- "device address matched in Ledger Live";
- "drill hashes matched on the device";
- "check printed matchesExpected true".

Note your Ledger model and Ethereum app version as well, so the [DEVICE TEST] items can be confirmed. The signature
itself is not needed.

## 5. Later, for real Safe signatures (not now)

The flow is the same, except that the operator sends you a file made by `safe-tx.mjs prepare`. On your own machine:
1. Run `node scripts\safe-tx.mjs inspect --tx <file>`. It must show chain ID **46630**, the planned Safe address, and
   the intended target and data.
2. Then sign as in step 3.2.5 and compare the two device hashes with **your own** `inspect` output, not with hashes
   someone sent you.
