import { describe, it, expect } from "vitest";
import { RADIX_NETWORK, XRD_ADDRESS } from "@/lib/radix";

describe("Radix network configuration", () => {
  it("should target mainnet (network_id: 1)", () => {
    expect(RADIX_NETWORK.networkId).toBe(1);
    expect(RADIX_NETWORK.networkName).toBe("mainnet");
  });

  it("should use the correct mainnet gateway", () => {
    expect(RADIX_NETWORK.gatewayUrl).toBe("https://mainnet.radixdlt.com");
  });

  it("should never reference stokenet", () => {
    expect(RADIX_NETWORK.gatewayUrl).not.toContain("stokenet");
  });

  it("should use the canonical XRD resource address", () => {
    expect(XRD_ADDRESS).toBe(
      "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"
    );
  });
});
