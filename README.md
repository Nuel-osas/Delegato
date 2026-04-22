# Delegato

Day 2 demo for moving signing authority out of hot wallets on Sui.

This repo shows a simple custody pattern:

- the owner wallet stays constant
- a delegated signer is generated server-side
- the delegated signer key is AES-wrapped
- the AES key is Seal-wrapped
- wrapped custody state is stored on-chain in a derived `Delegator` object
- the delegated signer can execute only one allowed action

In the current version, that one allowed action is:

- send exactly `0.1 SUI`
- to exactly `0x7ced1dc8c5c41d1c2abf56ad0dada8077858c5eadde645ef4db0623cafa28def`

## What Students Will Learn

- how a wallet can stay the stable owner while a separate signer executes
- how wrapped key material can live on-chain without exposing plaintext keys
- how Seal is used to wrap and later recover an AES key
- how a frontend can orchestrate the flow without becoming the signing boundary
- how a Move contract can strictly constrain what the delegated signer may do

## Repo Layout

```text
.
├── client/   React + Vite + dApp Kit frontend
├── move/     Move package with Registry + Delegator logic
└── server/   Bun + TypeScript enclave-style service
```

## Current Testnet Deployment

These IDs are already wired into the code:

- Package: `0xe616c1efee02f30462788cbd20c04d2a4a640cca91e62a5d3f0b178f4155512b`
- Registry: `0x4990d853c6073971aaf9d1a9238304431d79a7f13768386faebdcbd0c14f35cf`
- Publish tx: `2EV9PftnrXoTcYrrfNVaRN6WZbTyyqJUqXTvHmQ6d31Q`

These live in:

- [`client/src/App.tsx`](./client/src/App.tsx)
- [`server/src/index.ts`](./server/src/index.ts)

## Prerequisites

Students need:

- `git`
- `bun`
- `sui` CLI
- a browser wallet that supports Sui testnet
- a funded Sui testnet wallet for setup gas

Quick checks:

```bash
bun --version
sui --version
```

## Clone And Install

```bash
git clone https://github.com/Nuel-osas/Delegato.git
cd Delegato
```

Install dependencies:

```bash
cd server && bun install
cd ../client && bun install
cd ..
```

## Run The Demo

### 1. Start the server

```bash
cd server
bun run dev
```

Expected output includes:

- `vault-demo server listening on http://localhost:3004`
- a fresh local `enclave address`

### 2. Start the frontend

Open a second terminal:

```bash
cd client
bun run dev
```

Open the app at:

- `http://localhost:5176`

## Frontend Flow

From the UI, do this in order:

1. Connect a funded testnet wallet.
2. Click `Generate wrapped signer`.
3. Click `Create delegator on-chain`.
4. Click `Fund signer with 0.2 SUI`.
5. Click `Send fixed payout`.
6. Click `Rotate Seal envelope`.

What each step does:

1. `Generate wrapped signer`
   The frontend asks the server to generate a delegated signer, AES-wrap the signer key, and Seal-wrap the AES key.
2. `Create delegator on-chain`
   Your wallet writes that wrapped state on-chain into the derived `Delegator` object.
3. `Fund signer with 0.2 SUI`
   Your wallet sends SUI to the delegated signer so it can pay gas and send the fixed payout itself.
4. `Send fixed payout`
   The server reconstructs the delegated signer inside the enclave-style flow and executes the one allowed Move action.
5. `Rotate Seal envelope`
   The server re-wraps the AES key under the next Seal identity version without changing the delegated signer.

## What The Demo Actually Sends

This is important:

- the delegated action is not arbitrary
- it does not let the signer send to any address
- it does not let the signer choose any amount

It sends only:

- amount: `0.1 SUI`
- recipient: `0x7ced1dc8c5c41d1c2abf56ad0dada8077858c5eadde645ef4db0623cafa28def`

That rule is enforced in:

- [`move/sources/conductor_demo.move`](./move/sources/conductor_demo.move)

## What Runs Where

### In the frontend

- connect wallet
- sign the setup message
- create the `Delegator`
- fund the delegated signer
- call the server endpoints

### In the server

- generate the delegated signer
- AES-encrypt the delegated signer seed
- Seal-encrypt the AES key
- recover the AES key during execution
- decrypt the delegated signer key
- sign and execute the fixed payout
- rotate the Seal envelope

The frontend can trigger the whole flow, but it is not the signing boundary.

## Key Concepts

### Owner wallet

The owner wallet stays constant and controls setup/admin actions.

### Delegated signer

The delegated signer is a separate key that actually executes the allowed transaction.

### Delegator object

The `Delegator` object is the on-chain custody record. It stores:

- `owner`
- `signing_address`
- `signing_pk`
- `enclave_address`
- `key_version`
- `encrypted_sk`
- `sealed_aes_key`
- `allowed_targets`

It is the source of truth for:

- who owns the signer flow
- which delegated signer is allowed to act
- what wrapped key material belongs to it
- what target that signer is allowed to call

## Build Checks

```bash
cd move && sui move build
cd ../server && bun run build
cd ../client && bun run build
```

## If You Change The Move Package

If you publish your own package instead of using the current one:

```bash
cd move
sui client publish --gas-budget 100000000
```

Then update the new package and registry IDs in:

- [`client/src/App.tsx`](./client/src/App.tsx)
- [`server/src/index.ts`](./server/src/index.ts)

## Troubleshooting

### The server restarted and execute stopped working

The local server generates a fresh enclave identity on restart.

If the on-chain `Delegator` still points to the old enclave address:

1. refresh the app
2. click the rebind action in the UI
3. try `Send fixed payout` again

### My signer has no SUI

Run the `Fund signer with 0.2 SUI` step again.

### The wallet is on the wrong network

Use Sui testnet in the wallet. The current app and package IDs are testnet-only.

## Classroom Summary

The shortest correct explanation is:

- the wallet remains the stable owner
- the delegated signer executes the transaction
- the wrapped signer state lives on-chain in the `Delegator`
- the server recovers the signer only inside the enclave-style flow
- the delegated action is locked to a fixed `0.1 SUI` payout to one fixed recipient
