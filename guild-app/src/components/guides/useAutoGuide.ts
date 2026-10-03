"use client"

import { useEffect, useRef } from "react"
import { useGuide } from "@/components/guides"

export function useAutoGuide(guideId: string, delayMs = 2000) {
  const { openGuide } = useGuide()

  // openGuide can change identity while the timer is pending (e.g. the
  // provider re-rendering after localStorage hydration). If the timer
  // effect depended on it, that re-render would clear the pending timeout
  // before it ever fired. Read the latest callback through a ref instead.
  const openGuideRef = useRef(openGuide)
  useEffect(() => {
    openGuideRef.current = openGuide
  }, [openGuide])

  useEffect(() => {
    const t = setTimeout(() => openGuideRef.current(guideId), delayMs)
    return () => clearTimeout(t)
  }, [guideId, delayMs])
}
