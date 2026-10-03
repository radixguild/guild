"use client";
import { WalletProvider } from "@/hooks/useWallet";
import { ThemeProvider } from "@/hooks/useTheme";
import { GuideProvider } from "@/components/guides";
import { XrdUsdProvider } from "@/lib/use-xrd-usd";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <WalletProvider>
        <GuideProvider>
          <XrdUsdProvider>{children}</XrdUsdProvider>
        </GuideProvider>
      </WalletProvider>
    </ThemeProvider>
  );
}
