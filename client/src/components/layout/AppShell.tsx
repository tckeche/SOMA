import type { PropsWithChildren } from "react";
export function AppShell({ children }: PropsWithChildren) { return <div className="min-h-[100dvh] overflow-x-clip bg-background text-foreground antialiased">{children}</div>; }
