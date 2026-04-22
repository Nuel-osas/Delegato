# Delegato

Day 2 demo for moving signing authority out of hot wallets on Sui.

This repo is a focused standalone version of `vault-demo`: the owner wallet stays constant, a delegated signer is generated server-side, the signer seed is AES-wrapped, the AES key is Seal-wrapped, and Move stores the wrapped custody state on-chain in a derived `Delegator` object.

## What it demonstrates

- wallet-signed owner proof for setup
- deterministic `Delegator` creation on Sui testnet
- on-chain storage of `encrypted_sk`, `sealed_aes_key`, and `key_version`
- enclave-style execution through `/execute`
- Seal envelope rotation through `/rotate`
- explicit gas funding for the delegated signer

## Repo layout

```text
.
├── client/   React + Vite + dApp Kit frontend
├── move/     Move package with Delegator + seal policy
└── server/   Bun + TypeScript enclave-style service
```

## Current testnet deployment

- Package: `0xd8eac0d55f7a996922776a1b553ef8472282f027c4ac12c89427cfb5d1dfcca7`
- Registry: `0xe16d6d96a9215b500680629afa93caba495466260994be2b3ca9eabe105eb49e`
- Publish tx: `GgfN2UqXSb3sQ56dZ9YWFCPvG8bQQPV6ctC7r9tY9DiQ`

These IDs are already wired into:

- [`client/src/App.tsx`](./client/src/App.tsx)
- [`server/src/index.ts`](./server/src/index.ts)

## Run locally

### Server

```bash
cd server
bun install
bun run dev
```

### Client

```bash
cd client
bun install
bun run dev
```

Open `http://localhost:5176`.

## Demo flow

1. Connect a funded testnet wallet.
2. Generate a wrapped signer.
3. Create the `Delegator` on-chain.
4. Fund the delegated signer with a small amount of SUI.
5. Execute the demo action through the server.
6. Rotate the Seal envelope.

## Build checks

```bash
cd move && sui move build
cd ../server && bun run build
cd ../client && bun run build
```

## Important note

The local server generates a fresh enclave address on restart. If that happens, use the UI's rebind action so the on-chain `Delegator` points at the new enclave address before executing again.
