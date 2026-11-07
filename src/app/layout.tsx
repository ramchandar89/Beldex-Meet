import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Beldex Meet",
  description: "Private video meetings powered by LiveKit",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        // Browser extensions (e.g. ColorZilla's cz-shortcut-listen) add attributes
        // to <body> before React hydrates; don't treat that as a mismatch.
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
