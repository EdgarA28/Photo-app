import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { BookImage, ImageUp, Images, Settings, type LucideIcon } from "lucide-react";
import { Viewfinder } from "@/components/viewfinder";
import { cn } from "@/lib/utils";
import { shareInvitationsQuery } from "@/queries/shares";
import { isActive, useUploads } from "@/upload/useUploads";

interface NavItem {
  to: "/gallery" | "/albums" | "/upload" | "/settings";
  label: string;
  icon: LucideIcon;
}

// The four sections of §12.1; the viewer and album pages sit under Gallery / Albums.
const NAV: readonly NavItem[] = [
  { to: "/gallery", label: "Gallery", icon: Images },
  { to: "/albums", label: "Albums", icon: BookImage },
  { to: "/upload", label: "Upload", icon: ImageUp },
  { to: "/settings", label: "Settings", icon: Settings },
];

// Prefix matching (the default) keeps Albums current on /albums/$albumId.
const linkBase =
  "group relative flex items-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** Uploads still waiting or running (8.10), on the Upload item. */
function UploadCount({ className }: { className?: string }) {
  const count = useUploads().filter(isActive).length;
  return <CountBadge count={count} label={`${count} uploading`} className={className} />;
}

/** Album invitations waiting for an answer (FR-SHR-6), on the Albums item. */
function InvitationCount({ className }: { className?: string }) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const { data, hasNextPage } = useInfiniteQuery(shareInvitationsQuery(api));
  const count = data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0;
  const shown = hasNextPage ? `${count}+` : `${count}`;
  return (
    <CountBadge
      count={count}
      text={shown}
      label={`${shown} album ${count === 1 && !hasNextPage ? "invitation" : "invitations"}`}
      className={className}
    />
  );
}

function CountBadge({
  count,
  text = `${count}`,
  label,
  className,
}: {
  count: number;
  text?: string;
  label: string;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <span
      aria-label={label}
      className={cn(
        "min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 font-medium text-primary-foreground tabular-nums",
        className,
      )}
    >
      {text}
    </span>
  );
}

function ActiveFrame() {
  return <Viewfinder className="opacity-0 group-aria-[current=page]:opacity-100" />;
}

/** Bottom tab bar on small screens, clear of the home indicator in standalone mode. */
export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="grid grid-cols-4">
        {NAV.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex justify-center py-1.5">
            <Link
              to={to}
              className={cn(linkBase, "min-w-16 flex-col gap-0.5 px-3 py-1.5 text-[0.6875rem]")}
            >
              <ActiveFrame />
              <Icon aria-hidden className="size-5" />
              {label}
              {to === "/upload" && <UploadCount className="absolute top-0.5 right-2" />}
              {to === "/albums" && <InvitationCount className="absolute top-0.5 right-2" />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Left rail on medium screens and up. */
export function SideNav({ email }: { email: string | undefined }) {
  return (
    <aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col border-r px-3 py-5 md:flex">
      <Link
        to="/gallery"
        className="relative mx-2 mb-8 self-start rounded-sm px-2.5 py-1.5 text-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Viewfinder />
        Photo App
      </Link>
      <nav aria-label="Main">
        <ul className="space-y-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                className={cn(
                  linkBase,
                  "gap-3 px-3 py-2 text-sm hover:bg-muted/60 aria-[current=page]:bg-muted",
                )}
              >
                <ActiveFrame />
                <Icon aria-hidden className="size-4" />
                {label}
                {to === "/upload" && <UploadCount className="ml-auto" />}
                {to === "/albums" && <InvitationCount className="ml-auto" />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {email && (
        <p className="mt-auto truncate px-3 text-xs text-muted-foreground" title={email}>
          {email}
        </p>
      )}
    </aside>
  );
}
