import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Migration Compass",
  description:
    "Migration readiness assessment for legacy codebases: scorecard, findings, and dependency graph in one continuous page.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
