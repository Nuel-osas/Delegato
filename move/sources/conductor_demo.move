/// Day 2 conductor-style demo.
///
/// This removes content storage entirely and focuses on key custody:
/// - the user creates a deterministic Delegator object from their address
/// - the enclave generates a signing key, AES-wraps it, then Seal-wraps the AES key
/// - the encrypted key material lives on-chain in the Delegator
/// - delegated actions are signed by the recovered key, not by a browser hot wallet
module content_vault::conductor_demo;

use std::string::String;
use sui::derived_object::{Self, claim};
use sui::event::emit;

const EUnauthorizedOwner: u64 = 0;
const EUnauthorizedSigner: u64 = 1;

public struct Registry has key {
    id: UID,
}

public struct DelegatorKey(address) has copy, drop, store;

public struct Delegator has key, store {
    id: UID,
    owner: address,
    signing_address: address,
    signing_pk: vector<u8>,
    enclave_address: address,
    key_version: u64,
    encrypted_sk: vector<u8>,
    sealed_aes_key: vector<u8>,
    allowed_targets: vector<String>,
}

public struct DelegatorCreated has copy, drop {
    delegator_id: ID,
    owner: address,
    signing_address: address,
    enclave_address: address,
}

public struct SealKeyRotated has copy, drop {
    delegator_id: ID,
    key_version: u64,
}

public struct AllowedTargetsUpdated has copy, drop {
    delegator_id: ID,
    count: u64,
}

public struct EnclaveAddressUpdated has copy, drop {
    delegator_id: ID,
    enclave_address: address,
}

public struct DemoActionExecuted has copy, drop {
    delegator_id: ID,
    owner: address,
    signing_address: address,
    label: vector<u8>,
    digest: vector<u8>,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry { id: object::new(ctx) });
}

/// Create the caller's Delegator as a derived object.
///
/// The owner always remains the wallet that creates the delegator.
/// The signing address is the enclave-generated key that later executes delegated actions.
public fun new(
    registry: &mut Registry,
    signing_pk: vector<u8>,
    signing_address: address,
    enclave_address: address,
    encrypted_sk: vector<u8>,
    sealed_aes_key: vector<u8>,
    allowed_targets: vector<String>,
    ctx: &mut TxContext,
) {
    let owner = ctx.sender();

    let delegator = Delegator {
        id: claim(&mut registry.id, DelegatorKey(owner)),
        owner,
        signing_address,
        signing_pk,
        enclave_address,
        key_version: 0,
        encrypted_sk,
        sealed_aes_key,
        allowed_targets,
    };

    emit(DelegatorCreated {
        delegator_id: delegator.id.to_inner(),
        owner,
        signing_address: delegator.signing_address,
        enclave_address: delegator.enclave_address,
    });

    transfer::share_object(delegator);
}

/// Re-wrap the AES key under a new Seal identity version.
/// The AES-wrapped signing key itself never changes.
public fun rotate_seal_key(
    self: &mut Delegator,
    new_sealed_aes_key: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == self.signing_address, EUnauthorizedSigner);
    self.key_version = self.key_version + 1;
    self.sealed_aes_key = new_sealed_aes_key;

    emit(SealKeyRotated {
        delegator_id: self.id.to_inner(),
        key_version: self.key_version,
    });
}

/// Owner-controlled allowlist for enclave-side PTB validation.
public fun set_allowed_targets(
    self: &mut Delegator,
    targets: vector<String>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == self.owner, EUnauthorizedOwner);
    self.allowed_targets = targets;

    emit(AllowedTargetsUpdated {
        delegator_id: self.id.to_inner(),
        count: vector::length(&self.allowed_targets),
    });
}

/// Owner-controlled rebind for the local demo when the enclave identity changes.
public fun set_enclave_address(
    self: &mut Delegator,
    enclave_address: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == self.owner, EUnauthorizedOwner);
    self.enclave_address = enclave_address;

    emit(EnclaveAddressUpdated {
        delegator_id: self.id.to_inner(),
        enclave_address: self.enclave_address,
    });
}

/// The delegated signer proves control by executing this action directly.
entry fun record_demo_action(
    self: &Delegator,
    label: vector<u8>,
    digest: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == self.signing_address, EUnauthorizedSigner);

    emit(DemoActionExecuted {
        delegator_id: self.id.to_inner(),
        owner: self.owner,
        signing_address: self.signing_address,
        label,
        digest,
    });
}

public fun owner(self: &Delegator): address { self.owner }
public fun signing_address(self: &Delegator): address { self.signing_address }
public fun signing_pk(self: &Delegator): &vector<u8> { &self.signing_pk }
public fun enclave_address(self: &Delegator): address { self.enclave_address }
public fun key_version(self: &Delegator): u64 { self.key_version }
public fun encrypted_sk(self: &Delegator): &vector<u8> { &self.encrypted_sk }
public fun sealed_aes_key(self: &Delegator): &vector<u8> { &self.sealed_aes_key }
public fun allowed_targets(self: &Delegator): &vector<String> { &self.allowed_targets }
public fun allowed_target_count(self: &Delegator): u64 { vector::length(&self.allowed_targets) }

public fun derive_delegator_address(registry: &Registry, owner: address): address {
    let registry_id = registry.id.to_inner();
    derived_object::derive_address(registry_id, DelegatorKey(owner))
}
