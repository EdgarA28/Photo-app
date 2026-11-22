/**
 * A small Google Photos-style pinwheel next to "Import from Google Photos" (user request
 * 2026-11-22): four half-disc petals in Google's colours, drawn here (no image file to load).
 * Names the service the import comes from; decorative, so hidden from screen readers.
 */
export function GooglePhotosIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="4 4 16 16" aria-hidden className={className}>
      <path d="M4 12a4 4 0 0 1 8 0Z" fill="#EA4335" />
      <path d="M12 4a4 4 0 0 1 0 8Z" fill="#FBBC04" />
      <path d="M20 12a4 4 0 0 1-8 0Z" fill="#34A853" />
      <path d="M12 20a4 4 0 0 1 0-8Z" fill="#4285F4" />
    </svg>
  );
}
