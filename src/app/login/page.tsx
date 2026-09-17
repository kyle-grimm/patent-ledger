import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in · Patent → LinkedIn Ledger",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-accent">Inventor research</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">Patent → LinkedIn Ledger</h1>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
