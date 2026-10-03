# UI Components

🔓 **Extractable later.** These primitives are generic shadcn — Phase-0.5 sweep can publish them as `@radix-guild/ui` consumed by both guild-public and guild-saas.

These are shadcn-style UI primitives built on `@base-ui/react`, with `cn()` from `@/lib/utils` and `class-variance-authority` for variants. Tailwind classes for styling. Most accept className for composition. Dark-mode-first design tokens.

## Component Inventory

| Component | File | Base | Notes |
|-----------|------|------|-------|
| Alert | alert.tsx | Custom | Alert, AlertTitle, AlertDescription, AlertAction |
| Badge | badge.tsx | Custom | Inline badge with variants |
| Button | button.tsx | @base-ui/react/button | Button with size and variant options |
| Card | card.tsx | Custom | Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter |
| Dialog | dialog.tsx | @base-ui/react/dialog | Modal dialog with overlay and content |
| DropdownMenu | dropdown-menu.tsx | @base-ui/react/menu | Context menu with items and separators |
| EmptyState | empty-state.tsx | Custom | Empty state with icon and action |
| Input | input.tsx | @base-ui/react/input | Text input field |
| Label | label.tsx | Custom | Form label element |
| Progress | progress.tsx | @base-ui/react/progress | Progress bar with track and indicator |
| Select | select.tsx | Custom | Native select dropdown |
| Separator | separator.tsx | @base-ui/react/separator | Horizontal or vertical divider |
| Skeleton | skeleton.tsx | Custom | Loading placeholder animation |
| Textarea | textarea.tsx | Custom | Multi-line text input |

## Usage Notes

Import components from `@/components/ui/<name>` (not from index). Variants are exported alongside components (e.g. `buttonVariants`). For toasts, import `toast` directly from `sonner`; the `<Toaster>` is mounted in the root layout.

Most components accept a `className` prop for additional styling. Composite components like Card export all sub-components. Base-UI components include built-in accessibility features and keyboard navigation.

Size variants typically include `xs`, `sm`, `default`, `lg`. Color variants include `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`. Check individual component files for available options.
