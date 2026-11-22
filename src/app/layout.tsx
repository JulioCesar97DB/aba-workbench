import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aba-workbench",
  description: "Phase 0: provider plumbing and writing rules. No interface yet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
