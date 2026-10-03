"use client";

/**
 * GuideProvider — Context that manages which guide is open and tracks
 * which guides the user has dismissed. Persists to localStorage so
 * guides don't re-appear on every page load.
 */

import { createContext, useContext, useState, useCallback, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { GuideDialog } from "./GuideDialog";
import { GUIDES, type Guide } from "./guides";

interface GuideState {
  activeGuide: string | null;
  dismissed: Set<string>;
  isAgent: boolean;
}

interface GuideContextValue extends GuideState {
  openGuide: (id: string, opts?: { force?: boolean }) => void;
  closeGuide: () => void;
  dismissGuide: (id: string) => void;
  resetAllGuides: () => void;
}

const GuideContext = createContext<GuideContextValue | null>(null);

const STORAGE_KEY = "guild-guides-dismissed";
const AGENT_KEY = "guild-agent-mode";

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function loadAgentMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AGENT_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDismissed(dismissed: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch { /* quota exceeded — silently skip */ }
}

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

export function GuideProvider({ children }: { children: ReactNode }) {
  const [activeGuide, setActiveGuide] = useState<string | null>(null);
  // Lazy initializers do the localStorage hydration (both loaders are
  // SSR-guarded) — no mount effect, no synchronous setState cascade. Initial
  // markup is unaffected: neither value renders anything on first paint.
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [isAgent] = useState(loadAgentMode);
  // Server snapshot false → dialog never in SSR markup; flips true on the
  // client without an effect (the app-shell `mounted` idiom).
  const hydrated = useSyncExternalStore(subscribeNoop, getTrue, getFalse);

  // Callbacks read dismissed through this ref so their identities stay
  // stable across dismissals. Consumers keep them in effect deps (see
  // useAutoGuide), and an identity change there would cancel a pending
  // auto-open timer.
  const dismissedRef = useRef(dismissed);

  // The dismissed set only suppresses automatic opens (useAutoGuide). An
  // explicit user action — the header Help menu — passes force so a guide
  // closed once stays reachable forever.
  const openGuide = useCallback((id: string, opts?: { force?: boolean }) => {
    if (!opts?.force && dismissedRef.current.has(id)) return;
    setActiveGuide(id);
  }, []);

  const closeGuide = useCallback(() => {
    setActiveGuide(null);
  }, []);

  const dismissGuide = useCallback((id: string) => {
    const next = new Set(dismissedRef.current);
    next.add(id);
    dismissedRef.current = next;
    setDismissed(next);
    persistDismissed(next);
    setActiveGuide(null);
  }, []);

  const resetAllGuides = useCallback(() => {
    const next = new Set<string>();
    dismissedRef.current = next;
    setDismissed(next);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const activeGuideData: Guide | null = activeGuide ? GUIDES[activeGuide] ?? null : null;

  const value = useMemo<GuideContextValue>(() => ({
    activeGuide, dismissed, isAgent,
    openGuide, closeGuide, dismissGuide, resetAllGuides,
  }), [activeGuide, dismissed, isAgent, openGuide, closeGuide, dismissGuide, resetAllGuides]);

  return (
    <GuideContext.Provider value={value}>
      {children}
      {hydrated && activeGuideData && (
        <GuideDialog
          guide={activeGuideData}
          open={!!activeGuide}
          onClose={() => dismissGuide(activeGuide!)}
          isAgent={isAgent}
        />
      )}
    </GuideContext.Provider>
  );
}

export function useGuide() {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error("useGuide must be used within GuideProvider");
  return ctx;
}
