// Shared app-shell header for the Warm Editorial redesign.
// Keeps MCEC branding + the SOMA wordmark, with the theme toggle and logout.
import { Link } from "wouter";
import { LogOut } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { ReactNode } from "react";

export function SomaHeader({
  roleLabel,
  displayName,
  initials,
  onLogout,
  rightActions,
}: {
  roleLabel: string;
  displayName: string;
  initials: string;
  onLogout: () => void;
  rightActions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="max-w-[1240px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
        <Link href="/">
          <div className="flex items-center gap-3 cursor-pointer" data-testid="link-dashboard-home">
            <img
              src="/MCEC - White Logo.png"
              alt="MCEC Logo"
              loading="lazy"
              className="h-9 w-auto object-contain brightness-0 dark:brightness-100"
            />
            <div className="leading-none">
              <div className="soma-display text-[20px] tracking-tight text-foreground">SOMA</div>
              <div className="eyebrow text-[8.5px] mt-[3px]">MCEC · {roleLabel}</div>
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          {rightActions}
          <div className="hidden sm:block text-right whitespace-nowrap">
            <div className="text-[13.5px] font-semibold leading-tight text-foreground" data-testid="text-user-name">
              {displayName}
            </div>
            <div className="eyebrow text-[8.5px]">{roleLabel}</div>
          </div>
          <span className="avatar w-[38px] h-[38px] text-sm" data-testid="avatar-user">
            {initials}
          </span>
          <ThemeToggle size="sm" />
          <button
            onClick={onLogout}
            className="btn btn-quiet btn-sm px-2"
            aria-label="Log out"
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

export default SomaHeader;
