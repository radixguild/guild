"use client";
import { useId } from "react";
import Link from "next/link";

interface InfoTipProps {
  text: string;
  link?: string;
  linkLabel?: string;
}

/**
 * The little "?" that explains a term inline.
 *
 * ⚠️ Rewritten 2026-08-21. Every part of it was mouse-only:
 *   - the trigger was a `<span>` with `cursor-help`, so it was not focusable
 *     and a keyboard user could not reach it at all;
 *   - the tooltip revealed on `group-hover` alone — there was no
 *     `group-focus`/`focus-within` variant anywhere in the class list;
 *   - nothing associated the tooltip text with the trigger, so a screen-reader
 *     user got no description even on the surfaces that use it (/groups).
 *
 * A real `<button>` with `aria-describedby` fixes all three at once, and
 * `focus-within` on the wrapper means the same reveal path serves hover,
 * keyboard focus, and focus moving INTO the tooltip's own link.
 *
 * `type="button"` is load-bearing: these render inside forms on some surfaces,
 * and a bare <button> would default to submit.
 */
export function InfoTip({ text, link, linkLabel }: InfoTipProps) {
  const id = useId();
  return (
    <span className="relative inline-flex items-center group ml-1">
      <button
        type="button"
        aria-describedby={id}
        aria-label="More information"
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-muted text-muted-foreground text-[9px] font-bold cursor-help select-none border border-muted-foreground/20 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring transition-colors"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 bg-popover text-popover-foreground text-[11px] leading-tight rounded-md shadow-md border border-border max-w-[250px] w-max opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-150 z-50 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
      >
        {text}
        {link && (
          <>
            {" "}
            <Link href={link} className="text-primary hover:underline whitespace-nowrap">
              {linkLabel || "Learn more"}
            </Link>
          </>
        )}
        <span className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-border" />
      </span>
    </span>
  );
}
