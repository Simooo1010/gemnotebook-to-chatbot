import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieName, isSecureEnv, verifySessionToken } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · NotebookLM connector" };

export default async function LoginPage() {
  const jar = await cookies();
  if (verifySessionToken(jar.get(cookieName(isSecureEnv(process.env)))?.value, process.env)) redirect("/vault");
  return (
    <main>
      <h1>Sign in</h1>
      <p>Owner only. Enter your passphrase to manage the connected Google accounts.</p>
      <LoginForm />
    </main>
  );
}
