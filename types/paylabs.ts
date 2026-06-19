export interface PaylabsSource {
  id: string;
  canonical_url: string;
  source_title: string;
  publisher: string;
  source_type: string;
  fetched_at: string;
  normalized_sha256: string;
  excerpt: string;
  license_note: string | null;
}

export interface PaylabsCreator {
  id: string;
  display_name: string;
  wallet_address: string;
  profile_url: string | null;
  is_verified: boolean;
}

export interface PaylabsLesson {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  source_id: string;
  creator_id: string;
  price_usdc: number;
  estimated_minutes: number;
  difficulty: "beginner" | "intermediate" | "advanced";
  tags: string[];
  content_sha256: string;
  is_published: boolean;
  created_at: string;
  // joined
  source?: PaylabsSource;
  creator?: PaylabsCreator;
}

export interface PaylabsUnlock {
  id: string;
  lesson_id: string;
  user_wallet: string;
  payment_id: string;
  payment_rail: string;
  amount_usdc: number;
  payment_ref: string;
  tx_hash: string | null;
  gateway_settlement_ref: string | null;
  unlocked_at: string;
}

export interface PaylabsPayoutReceipt {
  id: string;
  lesson_id: string;
  unlock_id: string;
  creator_wallet: string;
  platform_wallet: string;
  treasury_wallet: string;
  gross_amount_usdc: number;
  creator_amount_usdc: number;
  platform_amount_usdc: number;
  treasury_amount_usdc: number;
  payment_ref: string;
  tx_hash: string | null;
  created_at: string;
  // joined
  lesson_title?: string;
  source_url?: string;
}

export interface PaylabsCompletion {
  id: string;
  lesson_id: string;
  user_wallet: string;
  unlock_id: string;
  proof_type: string;
  proof_hash: string;
  completed_at: string;
}

export interface X402PaymentChallenge {
  network: string;
  receiverAddress: string;
  amount: string;
  token: string;
  chainId: number;
  eip712Domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  typedData: Record<string, unknown>;
}
