"use client";
import { ThemeProvider as NextThemesProvider } from "next-themes";

// Dark-only by decision (bigdev 2026-07-18, frontend audit): the exchange-style
// UI is designed dark, and light mode shipped unreadable primary text (~1.7:1
// contrast on money-critical addresses). forcedTheme also overrides any "light"
// a previous visitor still has persisted in localStorage.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

export { useTheme } from "next-themes";
