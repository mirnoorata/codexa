import type { VerificationTrustTier } from "../../types.js";

export const VERIFICATION_TRUST_TIERS = ["none", "reported", "artifact-corroborated", "witnessed", "executed-by-autoverify"] as const;

const trustRank = new Map<VerificationTrustTier, number>(VERIFICATION_TRUST_TIERS.map((tier, index) => [tier, index]));

export function isVerificationTrustTier(value: unknown): value is VerificationTrustTier {
  return typeof value === "string" && trustRank.has(value as VerificationTrustTier);
}

export function verificationTrustTierOrNone(value: unknown): VerificationTrustTier {
  return isVerificationTrustTier(value) ? value : "none";
}

export function strongerVerificationTrustTier(left: VerificationTrustTier, right: VerificationTrustTier): VerificationTrustTier {
  const normalizedLeft = verificationTrustTierOrNone(left);
  const normalizedRight = verificationTrustTierOrNone(right);
  return (trustRank.get(normalizedLeft) ?? 0) >= (trustRank.get(normalizedRight) ?? 0) ? normalizedLeft : normalizedRight;
}

export function strongestVerificationTrustTier(tiers: Iterable<VerificationTrustTier>): VerificationTrustTier {
  let strongest: VerificationTrustTier = "none";
  for (const tier of tiers) {
    strongest = strongerVerificationTrustTier(strongest, tier);
  }
  return strongest;
}
