import { cn } from "@/lib/utils";

const CORNERS = [
  "top-0 left-0 border-t-2 border-l-2",
  "top-0 right-0 border-t-2 border-r-2",
  "bottom-0 left-0 border-b-2 border-l-2",
  "bottom-0 right-0 border-b-2 border-r-2",
];

/**
 * Camera-viewfinder corner marks framing the parent (which must be `relative`). The app's one
 * decorative motif: it frames the wordmark and the current page in the navigation.
 */
export function Viewfinder({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      {CORNERS.map((corner) => (
        <span key={corner} className={cn("absolute size-1.5 border-safelight", corner)} />
      ))}
    </span>
  );
}
