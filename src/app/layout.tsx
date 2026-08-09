import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Jubot",
  description: "לוח מחוונים פיננסי של משק הבית",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body className="min-h-dvh bg-stone-100 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
