"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => {
  return (
    <label
      className={cn(
        // `block` is load-bearing, not cosmetic — do not drop it back to the
        // default. A bare <label> is display:inline, and vertical margins have
        // no effect on a non-replaced inline box. Every form field in this app
        // sits in a `space-y-2` stack, whose Tailwind v4 rule puts
        // margin-block-end: 8px on each child except the last — which the
        // inline Label silently discarded. Measured on production 2026-09-16:
        // the label-to-control gap was 2px on EVERY labelled field (text,
        // number, date, textarea alike), not the intended 8px. An external
        // reporter filed it as "the date control almost overlaps the Date
        // label" on iPad, where the native date control made the tightest case
        // visible first; it was never about dates.
        "block text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Label.displayName = "Label";

export { Label };
