import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_Thai } from "next/font/google";

import { SiteHeader } from "@/components/site-header";
import { BEHAVIOUR_SCOPE } from "@/lib/learning/consent";
import { getConsentState, hasScope } from "@/lib/learning/session";
import { RouteTracker, TrackingProvider } from "@/lib/events/client/tracking-provider";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The app is Thai-only for the MVP (PRO-3 `mvp-scope` §3), so the Thai face is
 * the primary one rather than a fallback. Weight 400/600/700: body, buttons,
 * headings — nothing else, because each weight is another font file a child on
 * a slow connection waits for.
 */
const notoSansThai = Noto_Sans_Thai({
  variable: "--font-thai",
  subsets: ["thai", "latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "steamkid",
  description: "เรียนวิทยาศาสตร์แบบลงมือคิด มี AI ช่วยตรวจงานและบอกว่าจะเก่งขึ้นได้ยังไง",
};

export const viewport: Viewport = {
  themeColor: "#2f5fe0",
  // No `maximumScale`: a child who needs to pinch-zoom must be allowed to.
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * Consent is resolved on the server and handed to the tracker as a prop. The
   * browser never decides for itself whether it may emit — that answer belongs
   * to the guardian's record, not to client state.
   */
  const consent = await getConsentState();

  return (
    <html
      lang="th"
      className={`${notoSansThai.variable} ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <TrackingProvider consentGranted={hasScope(consent, BEHAVIOUR_SCOPE)}>
          <RouteTracker />
          <SiteHeader />
          {children}
        </TrackingProvider>
      </body>
    </html>
  );
}
