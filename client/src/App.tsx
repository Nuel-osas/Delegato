import { useEffect, useMemo, useState } from "react";
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import "./App.css";

const ENCLAVE_URL = "http://localhost:3004";
const PACKAGE_ID: string = "0xd8eac0d55f7a996922776a1b553ef8472282f027c4ac12c89427cfb5d1dfcca7";
const REGISTRY_ID: string = "0xe16d6d96a9215b500680629afa93caba495466260994be2b3ca9eabe105eb49e";
const EXPLORER = "https://testnet.suivision.xyz";
const FUND_AMOUNT_MIST = 20_000_000n;

type HealthResponse = {
  ok: boolean;
  mode: "LOCAL_DEMO_NOT_ATTESTED";
  package_id: string;
  registry_id: string;
  network: string;
  enclave_address: string;
  enclave_public_key: string;
  allowed_target: string;
  endpoints: Record<string, boolean>;
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

type DelegatorView = {
  objectId: string;
  owner: string;
  signingAddress: string;
  enclaveAddress: string;
  keyVersion: string;
  encryptedSkBytes: number;
  sealedAesKeyBytes: number;
  allowedTargets: string[];
};

type ExecuteResponse = {
  digest: string;
  label: string;
  digest_hex: string;
  signing_address: string;
  key_version: string;
};

type RotateResponse = {
  digest: string;
  previous_key_version: string;
  next_key_version: string;
};

const PACKAGE_CONFIGURED = PACKAGE_ID !== "0x0" && REGISTRY_ID !== "0x0";

export default function App() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutate: signAndExecute, isPending } = useSignAndExecuteTransaction();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [keyBundle, setKeyBundle] = useState<KeygenResponse | null>(null);
  const [delegator, setDelegator] = useState<DelegatorView | null>(null);
  const [signerBalanceMist, setSignerBalanceMist] = useState<string>("0");
  const [actionLabel, setActionLabel] = useState("rotate payouts for week one");
  const [lastServerAction, setLastServerAction] = useState<ExecuteResponse | null>(null);
  const [lastRotation, setLastRotation] = useState<RotateResponse | null>(null);
  const [createDigest, setCreateDigest] = useState<string | null>(null);
  const [fundDigest, setFundDigest] = useState<string | null>(null);
  const [rebindDigest, setRebindDigest] = useState<string | null>(null);
  const [loading, setLoading] = useState<
    "health" | "keygen" | "create" | "fund" | "refresh" | "execute" | "rotate" | "rebind" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const currentDelegatorId = keyBundle?.delegator_address ?? delegator?.objectId ?? "";
  const signerNeedsFunding = useMemo(() => BigInt(signerBalanceMist || "0") < FUND_AMOUNT_MIST, [signerBalanceMist]);
  const enclaveMismatch =
    !!health &&
    !!delegator &&
    normalizeHex(health.enclave_address) !== normalizeHex(delegator.enclaveAddress);

  useEffect(() => {
    void checkHealth();
  }, []);

  async function checkHealth() {
    setError(null);
    setLoading("health");
    try {
      const res = await fetch(`${ENCLAVE_URL}/health_check`);
      if (!res.ok) throw new Error(`health ${res.status}: ${await res.text()}`);
      setHealth(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function generateWrappedKey() {
    if (!account || !PACKAGE_CONFIGURED) return;

    setError(null);
    setLoading("keygen");
    setKeyBundle(null);
    setDelegator(null);
    setSignerBalanceMist("0");
    setLastServerAction(null);
    setLastRotation(null);
    setCreateDigest(null);
    setFundDigest(null);
    setRebindDigest(null);

    try {
      const challenge = randomHex(16);
      const message = buildKeygenMessage(account.address, challenge);
      const { signature } = await signPersonalMessage({
        message: new TextEncoder().encode(message),
      });

      const res = await fetch(`${ENCLAVE_URL}/keygen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_address: account.address,
          challenge,
          signature,
        }),
      });

      if (!res.ok) throw new Error(`keygen ${res.status}: ${await res.text()}`);

      const nextBundle = (await res.json()) as KeygenResponse;
      setKeyBundle(nextBundle);
      setHealth((prev) =>
        prev
          ? {
              ...prev,
              enclave_address: nextBundle.enclave_address,
            }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function createDelegator() {
    if (!account || !keyBundle || !PACKAGE_CONFIGURED) return;

    setError(null);
    setLoading("create");
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::conductor_demo::new`,
        arguments: [
          tx.object(REGISTRY_ID),
          tx.pure.vector("u8", hexToBytes(keyBundle.signing_public_key)),
          tx.pure.address(keyBundle.signing_address),
          tx.pure.address(keyBundle.enclave_address),
          tx.pure.vector("u8", hexToBytes(keyBundle.encrypted_sk)),
          tx.pure.vector("u8", hexToBytes(keyBundle.sealed_aes_key)),
          tx.pure.vector("string", keyBundle.allowed_targets),
        ],
      });

      const digest = await submitWalletTransaction(signAndExecute, tx);
      setCreateDigest(digest);
      await suiClient.waitForTransaction({ digest });
      await refreshDelegator(keyBundle.delegator_address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function fundSigner() {
    if (!keyBundle || !account) return;

    setError(null);
    setLoading("fund");
    try {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [FUND_AMOUNT_MIST]);
      tx.transferObjects([coin], keyBundle.signing_address);

      const digest = await submitWalletTransaction(signAndExecute, tx);
      setFundDigest(digest);
      await suiClient.waitForTransaction({ digest });
      await refreshSignerBalance(keyBundle.signing_address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function refreshDelegator(objectId = currentDelegatorId) {
    if (!objectId) return;

    setError(null);
    setLoading("refresh");
    try {
      const response = await suiClient.getObject({
        id: objectId,
        options: { showContent: true },
      });

      const fields =
        response.data?.content?.dataType === "moveObject" && !Array.isArray(response.data.content.fields)
          ? (response.data.content.fields as Record<string, unknown>)
          : null;

      if (!fields) throw new Error("delegator object not found on-chain yet");

      const nextDelegator = {
        objectId,
        owner: expectString(fields.owner, "owner"),
        signingAddress: expectString(fields.signing_address, "signing_address"),
        enclaveAddress: expectString(fields.enclave_address, "enclave_address"),
        keyVersion: expectString(fields.key_version, "key_version"),
        encryptedSkBytes: expectByteArray(fields.encrypted_sk, "encrypted_sk").length,
        sealedAesKeyBytes: expectByteArray(fields.sealed_aes_key, "sealed_aes_key").length,
        allowedTargets: expectStringArray(fields.allowed_targets, "allowed_targets"),
      } satisfies DelegatorView;

      setDelegator(nextDelegator);
      await refreshSignerBalance(nextDelegator.signingAddress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function refreshSignerBalance(address: string) {
    const balance = await suiClient.getBalance({ owner: address });
    setSignerBalanceMist(balance.totalBalance);
  }

  async function runDelegatedAction() {
    if (!currentDelegatorId || !actionLabel.trim()) return;

    setError(null);
    setLoading("execute");
    try {
      const res = await fetch(`${ENCLAVE_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delegator_id: currentDelegatorId,
          label: actionLabel.trim(),
        }),
      });

      if (!res.ok) throw new Error(`execute ${res.status}: ${await res.text()}`);

      const output = (await res.json()) as ExecuteResponse;
      setLastServerAction(output);
      await suiClient.waitForTransaction({ digest: output.digest });
      await refreshDelegator(currentDelegatorId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function rotateSealKey() {
    if (!currentDelegatorId) return;

    setError(null);
    setLoading("rotate");
    try {
      const res = await fetch(`${ENCLAVE_URL}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delegator_id: currentDelegatorId,
        }),
      });

      if (!res.ok) throw new Error(`rotate ${res.status}: ${await res.text()}`);

      const output = (await res.json()) as RotateResponse;
      setLastRotation(output);
      await suiClient.waitForTransaction({ digest: output.digest });
      await refreshDelegator(currentDelegatorId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function rebindEnclaveAddress() {
    if (!delegator || !health || !account) return;

    setError(null);
    setLoading("rebind");
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::conductor_demo::set_enclave_address`,
        arguments: [tx.object(delegator.objectId), tx.pure.address(health.enclave_address)],
      });

      const digest = await submitWalletTransaction(signAndExecute, tx);
      setRebindDigest(digest);
      await suiClient.waitForTransaction({ digest });
      await refreshDelegator(delegator.objectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Tomorrow · Chapter Two</p>
          <h1 className="hero-title">Conductor-Style Key Custody</h1>
          <p className="hero-sub">
            Walrus and SuiNS are gone. The wallet stays the stable owner, but the signing key is generated,
            wrapped, and later recovered only inside the enclave service.
          </p>
        </div>
        <ConnectButton />
      </section>

      <section className="steps">
        <Step n="1" label="Prove Owner" active={!keyBundle} done={!!keyBundle} />
        <div className={`step-line ${keyBundle ? "done" : ""}`} />
        <Step n="2" label="Create Delegator" active={!!keyBundle && !delegator} done={!!delegator} />
        <div className={`step-line ${delegator ? "done" : ""}`} />
        <Step
          n="3"
          label="Fund + Execute"
          active={!!delegator}
          done={!!lastServerAction || !!lastRotation}
        />
      </section>

      <div className="grid">
        <div>
          <section className="card">
            <h2>Health</h2>
            <p className="card-hint">
              Check the enclave service first. This local demo intentionally skips real Nitro attestation, but it
              still exposes the enclave identity that Seal policy depends on.
            </p>
            <div className="row">
              <button className="primary" onClick={() => void checkHealth()} disabled={loading === "health"}>
                {loading === "health" ? "Checking..." : "Check enclave health"}
              </button>
              {health ? <span className={`tag ${health.ok ? "success" : "warn"}`}>{health.mode}</span> : null}
            </div>
            {health ? (
              <div className="stats">
                <Stat label="Package">{shorten(health.package_id)}</Stat>
                <Stat label="Registry">{shorten(health.registry_id)}</Stat>
                <Stat label="Enclave">{shorten(health.enclave_address)}</Stat>
                <Stat label="Allowlisted target">{health.allowed_target}</Stat>
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Owner Proof + Keygen</h2>
            <p className="card-hint">
              The wallet signs a one-time message. The server verifies that ownership proof, derives the deterministic
              delegator address, generates a new signer, AES-wraps it, then Seal-wraps the AES key.
            </p>
            <div className="row">
              <button
                className="primary"
                onClick={() => void generateWrappedKey()}
                disabled={!account || !PACKAGE_CONFIGURED || loading === "keygen"}
              >
                {loading === "keygen" ? "Generating..." : "Generate wrapped signer"}
              </button>
              {!PACKAGE_CONFIGURED ? <span className="tag warn">Publish package first</span> : null}
            </div>
            {keyBundle ? (
              <div className="stats">
                <Stat label="Owner">{shorten(keyBundle.owner_address)}</Stat>
                <Stat label="Delegator">{linkObject(keyBundle.delegator_address)}</Stat>
                <Stat label="Signer">{shorten(keyBundle.signing_address)}</Stat>
                <Stat label="Encrypted SK bytes">{hexToBytes(keyBundle.encrypted_sk).length.toString()}</Stat>
                <Stat label="Sealed AES bytes">{hexToBytes(keyBundle.sealed_aes_key).length.toString()}</Stat>
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Wallet Setup</h2>
            <p className="card-hint">
              The wallet creates the derived on-chain delegator, then funds the generated signer with a small amount
              of SUI so the enclave-controlled key can submit transactions directly.
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={() => void createDelegator()}
                disabled={!keyBundle || loading === "create" || isPending}
              >
                {loading === "create" ? "Creating..." : "Create delegator on-chain"}
              </button>
              <button
                onClick={() => void fundSigner()}
                disabled={!keyBundle || loading === "fund" || isPending}
              >
                {loading === "fund" ? "Funding..." : "Fund signer with 0.02 SUI"}
              </button>
              <button onClick={() => void refreshDelegator()} disabled={!currentDelegatorId || loading === "refresh"}>
                {loading === "refresh" ? "Refreshing..." : "Refresh delegator"}
              </button>
            </div>
            <div className="stats compact">
              <Stat label="Create tx">{createDigest ? linkTx(createDigest) : "Not submitted"}</Stat>
              <Stat label="Fund tx">{fundDigest ? linkTx(fundDigest) : "Not submitted"}</Stat>
              <Stat label="Signer balance">{formatSui(signerBalanceMist)} SUI</Stat>
            </div>
          </section>
        </div>

        <div>
          <section className="card">
            <h2>On-Chain Delegator</h2>
            <p className="card-hint">
              This is the new contract shape. The delegator stores the protected key material, the current Seal key
              version, the enclave address, and the allowed Move targets.
            </p>
            {delegator ? (
              <div className="stats">
                <Stat label="Delegator">{linkObject(delegator.objectId)}</Stat>
                <Stat label="Owner">{shorten(delegator.owner)}</Stat>
                <Stat label="Signer">{shorten(delegator.signingAddress)}</Stat>
                <Stat label="Enclave">{shorten(delegator.enclaveAddress)}</Stat>
                <Stat label="Key version">{delegator.keyVersion}</Stat>
                <Stat label="Allowed targets">{delegator.allowedTargets.join(", ")}</Stat>
              </div>
            ) : (
              <p className="empty">No delegator loaded yet.</p>
            )}
            {enclaveMismatch ? (
              <div className="callout warn">
                <p>The local server restarted with a new enclave address. Rebind the delegator before executing.</p>
                <button onClick={() => void rebindEnclaveAddress()} disabled={loading === "rebind" || isPending}>
                  {loading === "rebind" ? "Rebinding..." : "Rebind enclave address"}
                </button>
                {rebindDigest ? <p className="micro">Tx: {linkTx(rebindDigest)}</p> : null}
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Delegated Action</h2>
            <p className="card-hint">
              The enclave service now decrypts the Seal-wrapped AES key, decrypts the stored signer seed, and submits
              the allowlisted transaction directly from the funded signer address.
            </p>
            <label className="field">
              <span>Action label</span>
              <input
                className="text"
                value={actionLabel}
                onChange={(event) => setActionLabel(event.target.value)}
                placeholder="enter a label for the demo action"
              />
            </label>
            <div className="actions">
              <button
                className="primary"
                onClick={() => void runDelegatedAction()}
                disabled={!delegator || loading === "execute" || signerNeedsFunding || enclaveMismatch}
              >
                {loading === "execute" ? "Executing..." : "Execute via enclave signer"}
              </button>
              <button
                onClick={() => void rotateSealKey()}
                disabled={!delegator || loading === "rotate" || signerNeedsFunding || enclaveMismatch}
              >
                {loading === "rotate" ? "Rotating..." : "Rotate Seal envelope"}
              </button>
            </div>
            {signerNeedsFunding ? (
              <p className="micro warn-text">Fund the signer before server-side execution. It needs gas to submit.</p>
            ) : null}
            <div className="stats compact">
              <Stat label="Execute tx">{lastServerAction ? linkTx(lastServerAction.digest) : "Not submitted"}</Stat>
              <Stat label="Rotation tx">{lastRotation ? linkTx(lastRotation.digest) : "Not submitted"}</Stat>
              <Stat label="Current key version">
                {lastRotation ? lastRotation.next_key_version : delegator?.keyVersion ?? "0"}
              </Stat>
            </div>
          </section>

          <section className="card">
            <h2>What Changed</h2>
            <p className="card-hint">
              This is the exact architectural cut from the old vault demo to the Sona-style pattern.
            </p>
            <ul className="list">
              <li>Removed browser-side Seal decrypt and removed Walrus/SuiNS entirely.</li>
              <li>Stored `encrypted_sk`, `sealed_aes_key`, and `key_version` directly on the delegator.</li>
              <li>Made the owner wallet stable while the funded signer executes from the enclave path.</li>
              <li>Added Seal envelope rotation without re-encrypting the underlying signing key.</li>
            </ul>
          </section>
        </div>
      </div>

      {error ? (
        <div className="banner error">
          <strong>Error</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function Step(props: { n: string; label: string; active?: boolean; done?: boolean }) {
  return (
    <div className={`step ${props.done ? "done" : props.active ? "active" : ""}`}>
      <span className="step-n">{props.n}</span>
      <span>{props.label}</span>
    </div>
  );
}

function Stat(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <div className="stat-value">{props.children}</div>
    </div>
  );
}

function buildKeygenMessage(ownerAddress: string, challenge: string) {
  return `vault-demo::keygen|${PACKAGE_ID}|${REGISTRY_ID}|${ownerAddress}|${challenge}`;
}

function shorten(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function linkTx(digest: string) {
  return (
    <a href={`${EXPLORER}/txblock/${digest}`} target="_blank" rel="noreferrer">
      {shorten(digest)}
    </a>
  );
}

function linkObject(objectId: string) {
  return (
    <a href={`${EXPLORER}/object/${objectId}`} target="_blank" rel="noreferrer">
      {shorten(objectId)}
    </a>
  );
}

function formatSui(mist: string) {
  const value = Number(mist) / 1_000_000_000;
  return value.toFixed(value >= 0.01 ? 3 : 6);
}

function randomHex(bytes: number) {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToHex(buffer);
}

function bytesToHex(bytes: Uint8Array) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: string) {
  const normalized = normalizeHex(hex).slice(2);
  if (normalized.length % 2 !== 0) {
    throw new Error("invalid hex string");
  }

  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function normalizeHex(value: string) {
  return value.startsWith("0x") ? value.toLowerCase() : `0x${value.toLowerCase()}`;
}

function expectString(value: unknown, field: string) {
  if (typeof value !== "string") {
    throw new Error(`expected ${field} to be a string`);
  }

  return value;
}

function expectStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`expected ${field} to be a string array`);
  }

  return [...value];
}

function expectByteArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`expected ${field} to be a byte array`);
  }

  return Uint8Array.from(value);
}

function submitWalletTransaction(
  signAndExecute: ReturnType<typeof useSignAndExecuteTransaction>["mutate"],
  transaction: Transaction,
) {
  return new Promise<string>((resolve, reject) => {
    signAndExecute(
      { transaction },
      {
        onSuccess: (result) => {
          if (!("digest" in result) || typeof result.digest !== "string") {
            reject(new Error("wallet returned no transaction digest"));
            return;
          }

          resolve(result.digest);
        },
        onError: (err: Error) => reject(err),
      },
    );
  });
}
