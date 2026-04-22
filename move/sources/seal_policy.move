/// Simplified Seal policy for the day 2 conductor demo.
///
/// The production Sona implementation binds this to `kagi::enclave::Enclave`.
/// This local teaching version stores the enclave address directly in the Delegator
/// and authorizes Seal decryption against that address.
module content_vault::seal_policy;

use content_vault::conductor_demo::Delegator;
use sui::bcs;

public struct SEAL_POLICY has drop {}

const EInvalidIdentity: u64 = 0;
const EDelegatorMismatch: u64 = 1;
const EInvalidKeyVersion: u64 = 2;
const EUnauthorizedEnclave: u64 = 3;
const ENotActive: u64 = 4;

/// Identity bytes: [delegator_id (address)][key_version (u64)]
entry fun seal_approve(
    id: vector<u8>,
    delegator: &Delegator,
    ctx: &TxContext,
) {
    let mut prepared = bcs::new(id);
    let delegator_id = prepared.peel_address();
    let key_version = prepared.peel_u64();
    assert!(prepared.into_remainder_bytes().length() == 0, EInvalidIdentity);

    assert!(
        object::id_to_address(&object::id(delegator)) == delegator_id,
        EDelegatorMismatch,
    );
    assert!(key_version <= delegator.key_version(), EInvalidKeyVersion);
    assert!(ctx.sender() == delegator.enclave_address(), EUnauthorizedEnclave);
    assert!(delegator.allowed_target_count() > 0, ENotActive);
}
