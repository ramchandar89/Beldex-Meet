"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { resolveAccount, signIn } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [signing, setSigning] = useState(false);

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    const user = resolveAccount(value);
    if (!user) {
      setError("Enter a valid BChat ID (05…) or a name.bdx handle. Try demo.bdx.");
      return;
    }
    setError("");
    setSigning(true);
    // Simulate the wallet signature round-trip.
    setTimeout(() => {
      signIn(user);
      router.replace("/");
    }, 600);
  };

  return (
    <main className="min-h-dvh bg-[#0b1120] text-white flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-xl">
        <h1 className="text-4xl sm:text-5xl font-bold leading-tight tracking-tight">
          Meet without handing over your identity.
        </h1>
        <p className="mt-4 text-lg text-[#aab3d4]">
          Sign in with your BChat ID. No email, no phone number.
        </p>

        <form onSubmit={handleSignIn} className="mt-8 flex flex-col gap-4">
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
            placeholder="BChat ID or name.bdx"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-2xl bg-[#1b2238] border border-[#2c3550] px-5 py-5 text-lg text-white placeholder:text-[#7b8198] outline-none focus:border-[#8b85f8]"
          />

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={signing}
            className="w-full rounded-2xl bg-[#8b85f8] px-5 py-5 text-lg font-bold text-[#1e1b4b] transition hover:bg-[#9d98fa] active:bg-[#7c75f0] disabled:opacity-70"
          >
            {signing ? "Signing…" : "Sign with Beldex wallet"}
          </button>
        </form>

        <p className="mt-4 text-sm text-[#7c8499]">
          Prototype: the wallet signature is simulated.
        </p>
      </div>
    </main>
  );
}
