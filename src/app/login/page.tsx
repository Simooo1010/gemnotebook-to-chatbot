import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieName, isSecureEnv, verifySessionToken } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/next";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · NotebookLM connector" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).next;
  const next = safeNextPath(typeof raw === "string" ? raw : null) ?? "/vault";
  const jar = await cookies();
  if (verifySessionToken(jar.get(cookieName(isSecureEnv(process.env)))?.value, process.env)) redirect(next);
  return (
    <main>
      <h1>Sign in</h1>
      <p>Owner only. Enter your passphrase to manage the connected Google accounts.</p>
      <LoginForm next={next} />
    </main>
  );
}
