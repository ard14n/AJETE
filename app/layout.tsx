import type { Metadata } from "next";
import Link from "next/link";
import { Plus_Jakarta_Sans, Rajdhani, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-drive-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const rajdhani = Rajdhani({
  variable: "--font-drive-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-drive-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "DRIVE Test Suite",
  description: "Exploration, Story Validation, and Legal Compliance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body
        className={`${plusJakartaSans.variable} ${rajdhani.variable} ${jetBrainsMono.variable} antialiased`}
      >
        <div className="suite-app-shell">
          <header className="suite-topbar">
            <div className="suite-topbar-brand">
              <span className="suite-topbar-title">DRIVE Test Suite</span>
              <span className="suite-topbar-subtitle">Exploration, Stories & Compliance</span>
            </div>
            <nav className="suite-topbar-nav">
              <Link href="/" className="suite-topbar-link">Exploration Suite</Link>
              <Link href="/stories" className="suite-topbar-link">Story Validation Suite</Link>
              <Link href="/legal" className="suite-topbar-link">Legal Suite</Link>
            </nav>
          </header>
          <main className="suite-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
