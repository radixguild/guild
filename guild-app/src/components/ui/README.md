# UI components

shadcn-style primitives built on `@base-ui/react`, with `cn()` from `@/lib/utils` and
`class-variance-authority` for variants. Styling is Tailwind, and the design tokens are
dark-mode first. Most components accept `className` for composition.

## Inventory

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
| LoadFailed | load-failed.tsx | Custom | Failure state for a data surface whose fetch failed; distinct from EmptyState on purpose, so an outage never reads as "nothing here" |
| Progress | progress.tsx | @base-ui/react/progress | Progress bar with track and indicator |
| Select | select.tsx | Custom | Native select dropdown |
| Separator | separator.tsx | @base-ui/react/separator | Horizontal or vertical divider |
| Skeleton | skeleton.tsx | Custom | Loading placeholder animation |
| Textarea | textarea.tsx | Custom | Multi-line text input |

## Usage

Import from `@/components/ui/<name>`, not from an index. Variants are exported alongside the
components (for example `buttonVariants`). For toasts, import `toast` from `sonner`; the
`<Toaster>` is mounted in the root layout. Composite components such as Card export all their
sub-components, and the Base UI components carry their own accessibility and keyboard handling.

Sizes are typically `xs`, `sm`, `default` and `lg`; variants are `default`, `secondary`,
`destructive`, `outline`, `ghost` and `link`. Check each component file for what it offers.
