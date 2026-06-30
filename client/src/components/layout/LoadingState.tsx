import { Loader2 } from "lucide-react";
export function LoadingState({ label = "Loading" }: { label?: string }) { return <div className="flex min-h-48 items-center justify-center gap-3 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /><span>{label}</span></div>; }
