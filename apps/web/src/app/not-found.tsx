import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brand } from "@/components/Brand";

export default function NotFound() {
  return (
    <main className="session-screen">
      <Brand />
      <h1>Page not found</h1>
      <p>Check the address or return to your deployment workspace.</p>
      <Link href="/" className="button primary">
        <ArrowLeft size={16} aria-hidden="true" /> Back to workspace
      </Link>
    </main>
  );
}
