"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getUser, signOut, type BeldexUser } from "@/lib/auth";

// Generate a short numeric room code like "482-913".
// Codes starting with 9 are (simulated) paid rooms that charge an entry fee.
function randomRoomCode(paid: boolean) {
  const first = paid ? 9 : 1 + Math.floor(Math.random() * 8);
  const rest = String(Math.floor(Math.random() * 100_000)).padStart(5, "0");
  const digits = `${first}${rest}`;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

const isPaidRoom = (code: string) => code.startsWith("9");

// Accept either a bare room code or a full/partial join URL and return the code.
function parseRoomInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const match = value.match(/\/rooms\/([^/?#\s]+)/);
  const code = match ? decodeURIComponent(match[1]) : value;
  return code.replace(/[^a-zA-Z0-9-_]/g, "") || null;
}

type ScheduledMeeting = {
  id: string;
  room: string;
  title: string;
  startsAt: string;
  durationMin: number;
  waitingRoom: boolean;
};

// Default schedule slot: the next half hour.
function nextSlot(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Home() {
  const router = useRouter();
  const [joinValue, setJoinValue] = useState("");
  const [error, setError] = useState("");
  const [chargeFee, setChargeFee] = useState(false);
  const [feeAmount, setFeeAmount] = useState("");
  const [feeError, setFeeError] = useState("");
  // Paid room awaiting the (simulated) entry-fee confirmation.
  const [pendingPaid, setPendingPaid] = useState<string | null>(null);
  const [pendingFee, setPendingFee] = useState<number | null>(null);
  const [checkingFee, setCheckingFee] = useState(false);
  const [creating, setCreating] = useState(false);
  const [user, setUser] = useState<BeldexUser | null>(null);
  const [checked, setChecked] = useState(false);

  // Gate the app behind the simulated Beldex sign-in.
  useEffect(() => {
    const u = getUser();
    if (!u) {
      router.replace("/login");
      return;
    }
    setUser(u);
    setChecked(true);
  }, [router]);

  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [scheduling, setScheduling] = useState(false);
  const [form, setForm] = useState({ title: "", startsAt: nextSlot(), durationMin: 30, waitingRoom: true });
  const [scheduleError, setScheduleError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadMeetings = useCallback(async (ownerId: string) => {
    try {
      const res = await fetch(`/api/meetings?owner=${encodeURIComponent(ownerId)}`);
      if (res.ok) setMeetings((await res.json()).meetings ?? []);
    } catch {
      /* offline — keep the current list */
    }
  }, []);

  useEffect(() => {
    if (user) loadMeetings(user.id);
  }, [user, loadMeetings]);

  const scheduleMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setScheduleError("");
    const start = new Date(form.startsAt);
    if (Number.isNaN(start.getTime())) {
      setScheduleError("Pick a valid date and time.");
      return;
    }
    const res = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        startsAt: start.toISOString(),
        ownerId: user.id,
        ownerName: user.name,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setScheduleError(body.error ?? "Could not schedule the meeting.");
      return;
    }
    setScheduling(false);
    setForm({ title: "", startsAt: nextSlot(), durationMin: 30, waitingRoom: true });
    loadMeetings(user.id);
  };

  const deleteScheduled = async (id: string) => {
    if (!user) return;
    await fetch(`/api/meetings?id=${encodeURIComponent(id)}&owner=${encodeURIComponent(user.id)}`, {
      method: "DELETE",
    }).catch(() => {});
    loadMeetings(user.id);
  };

  const copyInvite = (m: ScheduledMeeting) => {
    const link = `${window.location.origin}/rooms/${encodeURIComponent(m.room)}`;
    const when = new Date(m.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const text = `${user?.name ?? "Someone"} is inviting you to a Beldex Meet meeting.\n\nTopic: ${m.title}\nTime: ${when}\nJoin: ${link}\nMeeting code: ${m.room}`;
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const createMeeting = async () => {
    const code = randomRoomCode(chargeFee);
    if (chargeFee) {
      const fee = Number(feeAmount);
      if (!feeAmount.trim() || !Number.isFinite(fee) || fee <= 0) {
        setFeeError("Enter an entry fee greater than 0.");
        return;
      }
      if (!user) return;
      // Save the fee so people joining this code can see the amount.
      setCreating(true);
      const res = await fetch("/api/room/fee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: code, fee, ownerId: user.id }),
      }).catch(() => null);
      if (!res?.ok) {
        const body = await res?.json().catch(() => ({}));
        setFeeError(body?.error ?? "Could not save the entry fee. Try again.");
        setCreating(false);
        return;
      }
    }
    router.push(`/rooms/${code}`);
  };

  const joinMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = parseRoomInput(joinValue);
    if (!code) {
      setError("Enter a meeting code or paste a join link.");
      return;
    }
    if (isPaidRoom(code)) {
      setCheckingFee(true);
      let fee: number | null = null;
      try {
        const res = await fetch(`/api/room/fee?room=${encodeURIComponent(code)}`);
        if (res.ok) fee = (await res.json()).fee ?? null;
      } catch {
        /* show the generic paid-room notice */
      }
      setCheckingFee(false);
      setPendingFee(fee);
      setPendingPaid(code);
      return;
    }
    router.push(`/rooms/${encodeURIComponent(code)}`);
  };

  const handleSignOut = () => {
    signOut();
    router.replace("/login");
  };

  // Avoid flashing the home UI before the auth check resolves.
  if (!checked || !user) return null;

  return (
    <main className="min-h-dvh flex flex-col items-center gap-6 bg-[#0d1530] px-4 py-10 text-[#eef1ff]">
      {/* Signed-in user */}
      <div className="flex w-full max-w-md items-center gap-3 rounded-full border border-[#2b3766] bg-[#172250] py-2 pl-2 pr-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#8b7cff] text-sm font-semibold text-[#17133d]">
          {user.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{user.name}</span>
        <button
          onClick={handleSignOut}
          className="shrink-0 text-sm font-medium text-[#aab2d8] transition hover:text-white"
        >
          Sign out
        </button>
      </div>

      <h1 className="w-full max-w-md text-3xl font-bold tracking-tight sm:text-4xl">Start or join a meeting</h1>

      {/* New meeting */}
      <div className="w-full max-w-md rounded-2xl border border-[#2b3766] bg-[#172250] p-6">
        <h2 className="text-xl font-semibold">New meeting</h2>
        <label className="mt-3 flex cursor-pointer items-center justify-between gap-3">
          <span>Charge entry fee</span>
          <span className="relative inline-flex h-6 w-6 shrink-0">
            <input
              type="checkbox"
              checked={chargeFee}
              onChange={(e) => {
                setChargeFee(e.target.checked);
                setFeeError("");
              }}
              className="peer h-6 w-6 cursor-pointer appearance-none rounded-md border-2 border-[#8a8a8a] bg-[#3a3a3a] checked:border-[#8b7cff] checked:bg-[#8b7cff]"
            />
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute inset-0 hidden h-6 w-6 p-1 peer-checked:block"
              fill="none"
              stroke="#17133d"
              strokeWidth={3}
            >
              <path d="M5 12l5 5L20 7" />
            </svg>
          </span>
        </label>
        {chargeFee && (
          <div className="mt-2">
            <label htmlFor="fee-amount" className="mb-1.5 block text-sm text-[#aab2d8]">
              Entry fee amount
            </label>
            <div className="flex items-center rounded-xl border border-[#2b3766] bg-[#131c42] focus-within:border-[#8b7cff]">
              <input
                id="fee-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                autoFocus
                value={feeAmount}
                onChange={(e) => {
                  setFeeAmount(e.target.value);
                  setFeeError("");
                }}
                placeholder="e.g. 10"
                className="w-full bg-transparent px-4 py-3 text-base text-[#eef1ff] placeholder:text-[#6e7699] outline-none"
              />
              <span className="pr-4 text-sm font-semibold text-[#aab2d8]">BDX</span>
            </div>
            {feeError && <p className="mt-1.5 text-sm text-red-400">{feeError}</p>}
          </div>
        )}
        <button
          onClick={createMeeting}
          disabled={creating}
          className="mt-4 disabled:opacity-60 w-full rounded-xl bg-[#8b7cff] px-5 py-3 text-base font-semibold text-[#17133d] transition hover:bg-[#9d90ff] active:bg-[#7a6af0]"
        >
          {creating ? "Creating…" : "Create room"}
        </button>
      </div>

      {/* Join with a code */}
      <div className="w-full max-w-md rounded-2xl border border-[#2b3766] bg-[#172250] p-6">
        <h2 className="text-xl font-semibold">Join with a code</h2>
        <form onSubmit={joinMeeting} className="mt-4 flex flex-col gap-3">
          <input
            value={joinValue}
            onChange={(e) => {
              setJoinValue(e.target.value);
              setError("");
              setPendingPaid(null);
            }}
            placeholder="e.g. 482-913"
            className="w-full rounded-xl border border-[#2b3766] bg-[#131c42] px-4 py-3 text-base text-[#eef1ff] placeholder:text-[#6e7699] outline-none focus:border-[#8b7cff]"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          {pendingPaid ? (
            <div className="rounded-xl border border-[#8b7cff]/50 bg-[#8b7cff]/10 p-4 text-sm">
              <p>
                Room <span className="font-semibold">{pendingPaid}</span> charges an entry fee
                {pendingFee !== null && (
                  <>
                    {" "}of <span className="font-semibold">{pendingFee} BDX</span>
                  </>
                )}{" "}
                (simulated).
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => router.push(`/rooms/${encodeURIComponent(pendingPaid)}`)}
                  className="flex-1 rounded-lg bg-[#8b7cff] px-3 py-2 font-semibold text-[#17133d] transition hover:bg-[#9d90ff]"
                >
                  {pendingFee !== null ? `Pay ${pendingFee} BDX & join` : "Pay & join"}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingPaid(null)}
                  className="rounded-lg border border-[#2b3766] bg-[#131c42] px-3 py-2 font-medium transition hover:bg-[#1d2958]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="submit"
              disabled={checkingFee}
              className="w-full disabled:opacity-60 rounded-xl border border-[#2b3766] bg-[#131c42] px-5 py-3 text-base font-semibold transition hover:bg-[#1d2958]"
            >
              {checkingFee ? "Checking…" : "Join room"}
            </button>
          )}
        </form>
      </div>

      <p className="w-full max-w-md text-sm text-[#aab2d8]">
        Joining a code that starts with 9 simulates a paid room.
      </p>

      <div className="w-full max-w-md rounded-2xl bg-white text-[#171717] dark:bg-transparent dark:text-inherit">
      <div className="w-full max-w-md rounded-2xl border border-black/10 dark:border-white/15 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Scheduled meetings</h2>
          <button
            onClick={() => setScheduling((v) => !v)}
            className="rounded-lg border border-black/15 dark:border-white/20 px-3 py-1.5 text-sm font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            {scheduling ? "Cancel" : "Schedule"}
          </button>
        </div>

        {scheduling && (
          <form onSubmit={scheduleMeeting} className="mt-4 flex flex-col gap-3">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Topic (e.g. Weekly sync)"
              className="w-full rounded-xl border border-black/15 dark:border-white/20 bg-transparent px-4 py-2.5 outline-none focus:border-indigo-500"
            />
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-black/60 dark:text-white/60">
                Start
                <input
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  className="rounded-xl border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 text-sm text-black dark:text-white outline-none focus:border-indigo-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-black/60 dark:text-white/60">
                Duration
                <select
                  value={form.durationMin}
                  onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) })}
                  className="rounded-xl border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 text-sm text-black dark:text-white outline-none"
                >
                  {[15, 30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.waitingRoom}
                onChange={(e) => setForm({ ...form, waitingRoom: e.target.checked })}
                className="h-4 w-4 accent-indigo-600"
              />
              Enable waiting room
            </label>
            {scheduleError && <p className="text-sm text-red-500">{scheduleError}</p>}
            <button
              type="submit"
              className="w-full rounded-xl bg-indigo-600 px-5 py-2.5 font-medium text-white transition hover:bg-indigo-500"
            >
              Save meeting
            </button>
          </form>
        )}

        {meetings.length === 0 && !scheduling && (
          <p className="mt-3 text-sm text-black/50 dark:text-white/50">No upcoming meetings.</p>
        )}
        <ul className="mt-3 flex flex-col gap-3">
          {meetings.map((m) => (
            <li
              key={m.id}
              className="rounded-xl border border-black/10 dark:border-white/15 px-4 py-3"
              data-testid="scheduled-meeting"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{m.title}</p>
                  <p className="text-xs text-black/50 dark:text-white/50">
                    {new Date(m.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                    {m.durationMin} min · {m.room}
                  </p>
                </div>
                <button
                  onClick={() => router.push(`/rooms/${encodeURIComponent(m.room)}`)}
                  className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
                >
                  Start
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <button onClick={() => copyInvite(m)} className="text-indigo-500 hover:text-indigo-400">
                  {copiedId === m.id ? "Invitation copied!" : "Copy invitation"}
                </button>
                <a
                  href={`/api/meetings?id=${encodeURIComponent(m.id)}&format=ics`}
                  className="text-indigo-500 hover:text-indigo-400"
                >
                  Add to calendar
                </a>
                <button onClick={() => deleteScheduled(m.id)} className="text-red-500 hover:text-red-400">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      </div>

      <p className="text-xs text-[#6e7699]">
        Phase 1 · LiveKit video rooms · Beldex identity &amp; payments coming next
      </p>
    </main>
  );
}
