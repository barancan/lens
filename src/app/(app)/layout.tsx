import { requireSession } from "@/lib/auth/server";
import { NavLinks } from "@/components/nav-links";

// Server actions on these pages may launch agent work via `after()`.
export const maxDuration = 300;
// Every page reads live, per-user data; never prerender at build time.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireSession();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b bg-muted/30 md:w-52 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-4 px-4 py-3 md:block md:py-5">
          <div className="font-mono text-lg font-semibold tracking-widest">LENS</div>
          <p className="hidden text-xs text-muted-foreground md:mt-1 md:block">research agent</p>
        </div>
        <NavLinks />
        <form action="/api/auth/logout" method="post" className="hidden px-4 py-4 md:block">
          <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
            Sign out
          </button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
