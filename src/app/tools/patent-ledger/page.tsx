import type { Metadata } from "next";
import PatentLedgerClient from "./PatentLedgerClient";

export const metadata: Metadata = {
  title: "Patent → LinkedIn Ledger",
  description: "Internal tool: search patents by topic, company or CPC code and match inventors to LinkedIn profiles.",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function PatentLedgerPage() {
  return <PatentLedgerClient />;
}
