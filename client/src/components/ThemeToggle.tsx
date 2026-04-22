import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeToggleProps = {
  className?: string;
  size?: "sm" | "md";
};

export function ThemeToggle({ className, size = "md" }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isLight = mounted && resolvedTheme === "light";
  const nextLabel = isLight ? "Switch to dark theme" : "Switch to light theme";

  const dimensions = size === "sm" ? "h-8 w-8" : "h-9 w-9";

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={nextLabel}
      title={nextLabel}
      onClick={() => setTheme(isLight ? "dark" : "light")}
      className={cn(
        dimensions,
        "rounded-full border-border/70 bg-background/60 text-foreground backdrop-blur-md",
        "hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      data-testid="theme-toggle"
    >
      {mounted ? (
        isLight ? (
          <Moon className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Sun className="h-4 w-4" aria-hidden="true" />
        )
      ) : (
        <Sun className="h-4 w-4 opacity-0" aria-hidden="true" />
      )}
      <span className="sr-only">{nextLabel}</span>
    </Button>
  );
}

export default ThemeToggle;
