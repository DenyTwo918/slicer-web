import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "slicer — Průvodce tiskem",
  description: "Jednoduchý SLA slicer pro každého — vytiskni svůj model za 4 kroky.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
