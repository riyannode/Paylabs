export const config = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? "development",

  // Database (Supabase)
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Auth
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "24h",

  // Public
  publicOrigin: process.env.PAYLABS_PUBLIC_ORIGIN ?? "https://api.paylabs.xyz",

  // Arc
  arcChainId: Number(process.env.ARC_CHAIN_ID ?? "5042002"),
  arcRpcUrl: process.env.ARC_RPC_URL ?? process.env.RPC ?? "https://rpc.testnet.arc.network",
  arcExplorerTxBase: process.env.ARC_EXPLORER_TX_BASE ?? "https://testnet.arcscan.app/tx/",

  // x402
  x402Network: process.env.X402_NETWORK ?? "arc-testnet",
  x402ReceiverAddress: process.env.X402_RECEIVER_ADDRESS ?? "",
  x402DefaultAmountUsdc: process.env.X402_DEFAULT_AMOUNT_USDC ?? "0.000001",
  x402DefaultArticleAmountUsdc: process.env.X402_DEFAULT_ARTICLE_AMOUNT_USDC ?? "0.000001",
  x402DefaultVideoAmountUsdc: process.env.X402_DEFAULT_VIDEO_AMOUNT_USDC ?? "0.000001",

  // Circle Gateway
  circleGatewayApiKey: process.env.CIRCLE_GATEWAY_API_KEY ?? "",
  circleGatewayFacilitatorUrl: process.env.CIRCLE_GATEWAY_FACILITATOR_URL ?? "",
  circleGatewayWalletId: process.env.CIRCLE_GATEWAY_WALLET_ID ?? "",
  circleGatewayReceiverAddress: process.env.CIRCLE_GATEWAY_RECEIVER_ADDRESS ?? "",

  // Settlement
  settlementBatchThreshold: Number(process.env.SETTLEMENT_BATCH_THRESHOLD ?? "5"),

  // Sites
  supportedSourceSites: (process.env.SUPPORTED_SOURCE_SITES ?? "arc-community,sepiasearch").split(","),
  allowedSiteIds: (process.env.PAYLABS_ALLOWED_SITE_IDS ?? "arc-community,sepiasearch").split(","),
  allowedHosts: (process.env.PAYLABS_ALLOWED_HOSTS ?? "community.arc.io,community.arc.network,sepiasearch.org").split(","),

  // AI
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  aiSearchPriceUsdc: process.env.AI_SEARCH_PRICE_USDC ?? "0.000001",
  // THREAD_OPEN_PRICE_USDC preferred; CONTENT_OPEN_PRICE_USDC kept for backward compat
  threadOpenPriceUsdc: process.env.THREAD_OPEN_PRICE_USDC ?? process.env.CONTENT_OPEN_PRICE_USDC ?? "0.000001",
  maxSinglePaymentUsdc: process.env.MAX_SINGLE_PAYMENT_USDC ?? "0.000001",

  // Agent permissions
  agentAllowAiSearch: process.env.AGENT_ALLOW_AI_SEARCH === "true",
  // AGENT_ALLOW_THREAD_OPEN preferred; AGENT_ALLOW_CONTENT_ACCESS kept for backward compat
  agentAllowThreadOpen: (process.env.AGENT_ALLOW_THREAD_OPEN ?? process.env.AGENT_ALLOW_CONTENT_ACCESS) === "true",
  agentAllowWithdraw: false,
  agentAllowTransfer: false,
};
