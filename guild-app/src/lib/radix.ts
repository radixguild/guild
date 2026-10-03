// Radix network configuration — mainnet only (network_id: 1)
// NO stokenet/testnet references

export const RADIX_NETWORK = {
  networkId: 1,
  networkName: "mainnet",
  gatewayUrl: "https://mainnet.radixdlt.com",
} as const

// Canonical mainnet XRD resource address. Verified against auto-trader-xrd (live
// engine), scrypto-xrd, sats-dashboard, and guild-public — all use the ...radxrd
// suffix. The prior ...stcfkr value was a transcription error that would have made
// any XRD withdraw (e.g. escrow deposit) a CommittedFailure on mainnet.
export const XRD_ADDRESS =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
