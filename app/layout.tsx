import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://trace-lens.nejatians.chatgpt.site"),
  title: "TraceLens — Distributed log root-cause analysis",
  description: "Correlate Spring Boot logs across services and pods, reconstruct a failing call path, and find the probable source line.",
  openGraph: {
    title: "TraceLens",
    description: "Find where the failure actually began.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "TraceLens distributed log investigation" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TraceLens",
    description: "Find where the failure actually began.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
