import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SealClient, SessionKey } from "@mysten/seal";
import { bcs } from "@mysten/sui/bcs";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { deriveObjectID } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

const PORT = 3004;
const PACKAGE_ID: string = "0xe616c1efee02f30462788cbd20c04d2a4a640cca91e62a5d3f0b178f4155512b";
const REGISTRY_ID: string = "0x4990d853c6073971aaf9d1a9238304431d79a7f13768386faebdcbd0c14f35cf";
const NETWORK = "testnet";
const SESSION_TTL_MIN = 5;
const SEAL_THRESHOLD = 1;
const FIXED_RECIPIENT = "0x7ced1dc8c5c41d1c2abf56ad0dada8077858c5eadde645ef4db0623cafa28def";
const FIXED_PAYOUT_MIST = 100_000_000n;
const DEMO_TARGET = `${PACKAGE_ID}::conductor_demo::send_fixed_payout`;
const SEAL_SERVER_CONFIGS = [
  {
    objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
    weight: 1,
  },
];

type HealthResponse = {
  ok: boolean;
  mode: "LOCAL_DEMO_NOT_ATTESTED";
  package_id: string;
  registry_id: string;
  network: string;
  enclave_address: string;
  enclave_public_key: string;
  allowed_target: string;
  fixed_recipient: string;
  fixed_payout_mist: string;
  endpoints: Record<string, boolean>;
};

type KeygenRequest = {
  owner_address: string;
  challenge: string;
  signature: string;
};

type KeygenResponse = {
  delegator_address: string;
  owner_address: string;
  signing_address: string;
  signing_public_key: string;
  enclave_address: string;
  key_version: number;
  encrypted_sk: string;
  sealed_aes_key: string;
  allowed_targets: string[];
  message: string;
};

type ExecuteRequest = {
  delegator_id: string;
};

type ExecuteResponse = {
  digest: string;
  signing_address: string;
  key_version: string;
  recipient: string;
  amount_mist: string;
};

type RotateRequest = {
  delegator_id: string;
};

type RotateResponse = {
  digest: string;
  previous_key_version: string;
  next_key_version: string;
};

type DelegatorState = {
  objectId: string;
  owner: string;
  signingAddress: string;
  signingPk: Uint8Array;
  enclaveAddress: string;
  keyVersion: bigint;
  encryptedSk: Uint8Array;
  sealedAesKey: Uint8Array;
  allowedTargets: string[];
};

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK), network: NETWORK });
const enclaveKeypair = Ed25519Keypair.generate();
const sealClient = new SealClient({
  suiClient,
  serverConfigs: SEAL_SERVER_CONFIGS,
  verifyKeyServers: false,
});

createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (!req.url) {
      sendJson(res, 404, { error: "missing url" });
      return;
    }

    if (req.method === "GET" && req.url === "/") {
      sendJson(res, 200, { ok: true, service: "vault-demo-server" });
      return;
    }

    if (req.method === "GET" && req.url === "/health_check") {
      sendJson(res, 200, buildHealthResponse());
      return;
    }

    if (req.method === "POST" && req.url === "/keygen") {
      requireConfigured();
      const body = await readJson<KeygenRequest>(req);
      const response = await handleKeygen(body);
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && req.url === "/execute") {
      requireConfigured();
      const body = await readJson<ExecuteRequest>(req);
      const response = await handleExecute(body);
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && req.url === "/rotate") {
      requireConfigured();
      const body = await readJson<RotateRequest>(req);
      const response = await handleRotate(body);
      sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    sendJson(res, 400, { error: message });
  }
}).listen(PORT, () => {
  console.log(`vault-demo server listening on http://localhost:${PORT}`);
  console.log(`enclave address: ${enclaveKeypair.toSuiAddress()}`);
});

function buildHealthResponse(): HealthResponse {
  return {
    ok: PACKAGE_ID !== "0x0" && REGISTRY_ID !== "0x0",
    mode: "LOCAL_DEMO_NOT_ATTESTED",
    package_id: PACKAGE_ID,
    registry_id: REGISTRY_ID,
    network: NETWORK,
    enclave_address: enclaveKeypair.toSuiAddress(),
    enclave_public_key: bytesToHex(enclaveKeypair.getPublicKey().toRawBytes()),
    allowed_target: DEMO_TARGET,
    fixed_recipient: FIXED_RECIPIENT,
    fixed_payout_mist: FIXED_PAYOUT_MIST.toString(),
    endpoints: {
      keygen: true,
      execute: true,
      rotate: true,
    },
  };
}

async function handleKeygen(body: KeygenRequest): Promise<KeygenResponse> {
  if (!body.owner_address || !body.signature || !body.challenge) {
    throw new Error("owner_address, challenge, and signature are required");
  }

  const message = buildKeygenMessage(body.owner_address, body.challenge);
  await verifyPersonalMessageSignature(new TextEncoder().encode(message), body.signature, {
    address: body.owner_address,
    client: suiClient,
  });

  const signingSeed = crypto.getRandomValues(new Uint8Array(32));
  const signingKeypair = Ed25519Keypair.fromSecretKey(signingSeed);
  const signingAddress = signingKeypair.toSuiAddress();
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const encryptedSk = await aesEncrypt(aesKey, signingSeed);
  const delegatorAddress = deriveDelegatorAddress(body.owner_address);
  const sealedAesKey = await sealEncrypt(delegatorAddress, 0n, aesKey);

  try {
    return {
      delegator_address: delegatorAddress,
      owner_address: body.owner_address,
      signing_address: signingAddress,
      signing_public_key: bytesToHex(signingKeypair.getPublicKey().toRawBytes()),
      enclave_address: enclaveKeypair.toSuiAddress(),
      key_version: 0,
      encrypted_sk: bytesToHex(encryptedSk),
      sealed_aes_key: bytesToHex(sealedAesKey),
      allowed_targets: [DEMO_TARGET],
      message,
    };
  } finally {
    signingSeed.fill(0);
    aesKey.fill(0);
  }
}

async function handleExecute(body: ExecuteRequest): Promise<ExecuteResponse> {
  if (!body.delegator_id) {
    throw new Error("delegator_id is required");
  }

  const delegator = await fetchDelegator(body.delegator_id);
  const targetAllowed = delegator.allowedTargets.includes(DEMO_TARGET);
  if (!targetAllowed) {
    throw new Error("delegator does not allow the demo action target");
  }

  const aesKey = await decryptSealKeyWithRetry(delegator.objectId, delegator.keyVersion, delegator.sealedAesKey);
  const signingSeed = await aesDecrypt(aesKey, delegator.encryptedSk);
  const signingKeypair = Ed25519Keypair.fromSecretKey(signingSeed);

  try {
    if (signingKeypair.toSuiAddress() !== delegator.signingAddress) {
      throw new Error("recovered signing key does not match delegator signing_address");
    }

    const tx = new Transaction();
    tx.setSender(delegator.signingAddress);
    const [payoutCoin] = tx.splitCoins(tx.gas, [FIXED_PAYOUT_MIST]);
    tx.moveCall({
      target: DEMO_TARGET,
      arguments: [
        tx.object(delegator.objectId),
        payoutCoin,
      ],
    });

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: signingKeypair,
      options: { showEffects: true, showEvents: true },
    });

    return {
      digest: result.digest,
      signing_address: delegator.signingAddress,
      key_version: delegator.keyVersion.toString(),
      recipient: FIXED_RECIPIENT,
      amount_mist: FIXED_PAYOUT_MIST.toString(),
    };
  } finally {
    signingSeed.fill(0);
    aesKey.fill(0);
  }
}

async function handleRotate(body: RotateRequest): Promise<RotateResponse> {
  if (!body.delegator_id) {
    throw new Error("delegator_id is required");
  }

  const delegator = await fetchDelegator(body.delegator_id);
  const aesKey = await decryptSealKeyWithRetry(delegator.objectId, delegator.keyVersion, delegator.sealedAesKey);
  const signingSeed = await aesDecrypt(aesKey, delegator.encryptedSk);
  const signingKeypair = Ed25519Keypair.fromSecretKey(signingSeed);
  const nextKeyVersion = delegator.keyVersion + 1n;
  const nextSealedAesKey = await sealEncrypt(delegator.objectId, nextKeyVersion, aesKey);

  try {
    if (signingKeypair.toSuiAddress() !== delegator.signingAddress) {
      throw new Error("recovered signing key does not match delegator signing_address");
    }

    const tx = new Transaction();
    tx.setSender(delegator.signingAddress);
    tx.moveCall({
      target: `${PACKAGE_ID}::conductor_demo::rotate_seal_key`,
      arguments: [
        tx.object(delegator.objectId),
        tx.pure.vector("u8", Array.from(nextSealedAesKey)),
      ],
    });

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: signingKeypair,
      options: { showEffects: true },
    });

    return {
      digest: result.digest,
      previous_key_version: delegator.keyVersion.toString(),
      next_key_version: nextKeyVersion.toString(),
    };
  } finally {
    signingSeed.fill(0);
    aesKey.fill(0);
  }
}

async function fetchDelegator(objectId: string): Promise<DelegatorState> {
  const response = await suiClient.getObject({
    id: objectId,
    options: { showContent: true },
  });

  const rawFields = response.data?.content?.dataType === "moveObject" ? response.data.content.fields : null;
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    throw new Error(`delegator ${objectId} not found`);
  }
  const json = rawFields as Record<string, unknown>;

  return {
    objectId,
    owner: expectString(json.owner, "owner"),
    signingAddress: expectString(json.signing_address, "signing_address"),
    signingPk: expectBytes(json.signing_pk, "signing_pk"),
    enclaveAddress: expectString(json.enclave_address, "enclave_address"),
    keyVersion: BigInt(expectString(json.key_version, "key_version")),
    encryptedSk: expectBytes(json.encrypted_sk, "encrypted_sk"),
    sealedAesKey: expectBytes(json.sealed_aes_key, "sealed_aes_key"),
    allowedTargets: expectStringArray(json.allowed_targets, "allowed_targets"),
  };
}

function buildKeygenMessage(ownerAddress: string, challenge: string): string {
  return `vault-demo::keygen|${PACKAGE_ID}|${REGISTRY_ID}|${ownerAddress}|${challenge}`;
}

function deriveDelegatorAddress(ownerAddress: string): string {
  const keyBytes = bcs
    .struct("DelegatorKey", {
      owner: bcs.Address,
    })
    .serialize({ owner: ownerAddress })
    .toBytes();

  return deriveObjectID(REGISTRY_ID, `${PACKAGE_ID}::conductor_demo::DelegatorKey`, keyBytes);
}

function buildSealIdentity(delegatorId: string, keyVersion: bigint): Uint8Array {
  return bcs
    .struct("SealIdentity", {
      delegator_id: bcs.Address,
      key_version: bcs.u64(),
    })
    .serialize({
      delegator_id: delegatorId,
      key_version: keyVersion,
    })
    .toBytes();
}

async function sealEncrypt(delegatorId: string, keyVersion: bigint, aesKey: Uint8Array) {
  const { encryptedObject } = await sealClient.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: PACKAGE_ID,
    id: bytesToHex(buildSealIdentity(delegatorId, keyVersion)),
    data: aesKey,
  });

  return new Uint8Array(encryptedObject);
}

async function decryptSealKeyWithRetry(
  delegatorId: string,
  keyVersion: bigint,
  sealedAesKey: Uint8Array,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await decryptSealKey(delegatorId, keyVersion, sealedAesKey);
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await sleep(2500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function decryptSealKey(delegatorId: string, keyVersion: bigint, sealedAesKey: Uint8Array) {
  const tx = new Transaction();
  tx.setSender(enclaveKeypair.toSuiAddress());
  tx.moveCall({
    target: `${PACKAGE_ID}::seal_policy::seal_approve`,
    arguments: [
      tx.pure.vector("u8", Array.from(buildSealIdentity(delegatorId, keyVersion))),
      tx.object(delegatorId),
    ],
  });

  const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
  const sessionKey = await SessionKey.create({
    address: enclaveKeypair.toSuiAddress(),
    packageId: PACKAGE_ID,
    ttlMin: SESSION_TTL_MIN,
    signer: enclaveKeypair,
    suiClient,
  });

  return new Uint8Array(
    await sealClient.decrypt({
      data: sealedAesKey,
      sessionKey,
      txBytes,
    }),
  );
}

async function aesEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", asBufferSource(keyBytes), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce) },
      key,
      asBufferSource(plaintext),
    ),
  );

  const output = new Uint8Array(nonce.length + ciphertext.length);
  output.set(nonce);
  output.set(ciphertext, nonce.length);
  return output;
}

async function aesDecrypt(keyBytes: Uint8Array, payload: Uint8Array) {
  const nonce = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const key = await crypto.subtle.importKey("raw", asBufferSource(keyBytes), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce) },
      key,
      asBufferSource(ciphertext),
    ),
  );
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as T;
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function requireConfigured() {
  if (PACKAGE_ID === "0x0" || REGISTRY_ID === "0x0") {
    throw new Error("configure PACKAGE_ID and REGISTRY_ID before using the server");
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${field} to be a string`);
  }

  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`expected ${field} to be a string array`);
  }

  return [...value];
}

function expectBytes(value: unknown, field: string): Uint8Array {
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }

  if (typeof value === "string") {
    return hexToBytes(value);
  }

  throw new Error(`expected ${field} to be bytes`);
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("invalid hex string");
  }

  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return Uint8Array.from(bytes) as BufferSource;
}
