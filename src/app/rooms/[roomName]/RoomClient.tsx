"use client";

import "@livekit/components-styles";

import {
  LiveKitRoom,
  VideoConference,
  PreJoin,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  type LocalUserChoices,
} from "@livekit/components-react";
import { ConnectionState, DisconnectReason, type RoomOptions } from "livekit-client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getUser } from "@/lib/auth";
import MeetingExtras from "./MeetingExtras";
import SettingsPanel from "./SettingsPanel";
import {
  MeetingContext,
  ViewPrefsContext,
  isWaiting,
  useParticipantTick,
  useRoles,
  useViewPrefsState,
} from "./meeting";

type Joined = { token: string; waiting: boolean };

// Why the call ended, when it wasn't our own choice.
function endedMessage(reason?: DisconnectReason): string | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      return null;
    case DisconnectReason.ROOM_DELETED:
      return "The host ended the meeting.";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "You were removed from the meeting by the host.";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "You joined this meeting from another window.";
    default:
      return "You were disconnected from the meeting.";
  }
}

// The configured LiveKit URL points at the dev machine's own localhost. When the
// app is opened from another machine over HTTPS (scripts/lan-proxy.mjs), connect
// to LiveKit through the same origin instead: the proxy forwards /rtc to it, and
// an https page may only open wss:// sockets.
function livekitUrlForBrowser(configured: string): string {
  if (typeof window === "undefined") return configured;
  const isLocal = /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(configured);
  if (isLocal && window.location.protocol === "https:") return `wss://${window.location.host}`;
  return configured;
}

export default function RoomClient({ roomName }: { roomName: string }) {
  const router = useRouter();
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const viewPrefs = useViewPrefsState();
  // Camera/mic need https (or localhost); null until checked on the client.
  const [secureUrl, setSecureUrl] = useState<string | null>(null);

  // Pre-fill the display name from the signed-in account.
  useEffect(() => {
    setDefaultName(getUser()?.name ?? "");
    if (!window.isSecureContext) {
      setSecureUrl(`https://${window.location.hostname}:3443${window.location.pathname}`);
    }
  }, []);

  const handlePreJoinSubmit = useCallback(
    async (values: LocalUserChoices) => {
      setError(null);
      try {
        const params = new URLSearchParams({ room: roomName, username: values.username });
        const userId = getUser()?.id;
        if (userId) params.set("userId", userId);
        const res = await fetch(`/api/token?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Token request failed (${res.status})`);
        }
        const { token, waiting } = await res.json();
        setChoices(values);
        setJoined({ token, waiting: waiting === true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not get a join token.");
      }
    },
    [roomName],
  );

  const copyLink = useCallback(() => {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const copyCode = useCallback(() => {
    navigator.clipboard?.writeText(roomName).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  }, [roomName]);

  const leave = useCallback(() => {
    setJoined(null);
    setChoices(null);
    router.push("/");
  }, [router]);

  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const msg = endedMessage(reason);
      if (!msg) return leave();
      setJoined(null);
      setChoices(null);
      setEnded(msg);
    },
    [leave],
  );

  // Use the devices picked on the pre-join screen, plus the saved audio
  // processing preferences from in-call Settings.
  const roomOptions = useMemo<RoomOptions>(() => {
    let processing = {};
    try {
      processing = JSON.parse(window.localStorage.getItem("beldex-meet-audio-processing") ?? "{}");
    } catch {
      /* storage unavailable */
    }
    return {
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: choices?.audioDeviceId || undefined, ...processing },
      videoCaptureDefaults: { deviceId: choices?.videoDeviceId || undefined },
    };
  }, [choices]);

  if (!serverUrl) {
    return (
      <main className="min-h-dvh flex items-center justify-center p-6 text-center">
        <p className="text-red-500">
          NEXT_PUBLIC_LIVEKIT_URL is not set. Add it to <code>.env.local</code> and restart the
          dev server.
        </p>
      </main>
    );
  }

  if (ended) {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-semibold">Meeting ended</h1>
        <p className="text-black/60 dark:text-white/60" data-testid="ended-message">
          {ended}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => setEnded(null)}
            className="rounded-xl border border-black/15 dark:border-white/20 px-5 py-2.5 font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            Rejoin
          </button>
          <button
            onClick={() => router.push("/")}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 font-medium text-white transition hover:bg-indigo-500"
          >
            Back to home
          </button>
        </div>
      </main>
    );
  }

  // Prejoin screen: device selection + display name, plus a shareable link.
  if (!joined || !choices) {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center gap-6 p-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-semibold">Meeting ready</h1>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            Share this code so another person can join.
          </p>

          <div className="mt-4 rounded-xl border border-dashed border-black/20 dark:border-white/25 px-4 py-4">
            <p className="text-xs uppercase tracking-wide text-black/40 dark:text-white/40">
              Meeting code
            </p>
            <p className="mt-1 select-all text-2xl font-bold tracking-wide text-indigo-500">
              {roomName}
            </p>
          </div>

          <div className="mt-3 flex items-center justify-center gap-3 text-sm">
            <button
              onClick={copyCode}
              className="text-indigo-500 underline underline-offset-4 hover:text-indigo-400"
            >
              {codeCopied ? "Code copied!" : "Copy code"}
            </button>
            <span className="text-black/30 dark:text-white/30">·</span>
            <button
              onClick={copyLink}
              className="text-indigo-500 underline underline-offset-4 hover:text-indigo-400"
            >
              {copied ? "Link copied!" : "Copy invite link"}
            </button>
          </div>
        </div>

        <div className="w-full max-w-md" data-lk-theme="default">
          {defaultName !== null && (
            <PreJoin
              defaults={{ username: defaultName, videoEnabled: true, audioEnabled: true }}
              onSubmit={handlePreJoinSubmit}
              onError={(e) => setError(e.message)}
            />
          )}
        </div>

        {secureUrl && (
          <div
            className="w-full max-w-md rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
            data-testid="insecure-warning"
          >
            <p className="font-medium">Camera and microphone are blocked on this address.</p>
            <p className="mt-1 text-black/70 dark:text-white/70">
              Browsers only allow them over a secure (https) connection. Open the secure address
              instead and accept the certificate warning once:
            </p>
            <a href={secureUrl} className="mt-2 inline-block break-all font-medium text-indigo-500 underline">
              {secureUrl}
            </a>
          </div>
        )}

        {error && <p className="max-w-md text-center text-sm text-red-500">{error}</p>}
      </main>
    );
  }

  // In the call: VideoConference provides tiles, the control bar
  // (mic, camera, screen share, chat, settings, leave) and the chat panel;
  // MeetingExtras layers the Zoom-style extras on top.
  return (
    <div data-lk-theme="default" style={{ height: "100dvh", position: "relative" }}>
      {/*
        Show only other participants in the grid — the local user sees
        themselves in the floating self view instead. Remote tiles have
        data-lk-local-participant="false", so they stay visible. Inlined here so
        Tailwind's CSS pipeline doesn't strip it.
      */}
      <style>{`.lk-participant-tile[data-lk-local-participant="true"] { display: none !important; }
        .lk-settings-menu-modal { z-index: 60 !important; max-height: calc(100dvh - 120px); overflow-y: auto; }`}</style>
      <LiveKitRoom
        token={joined.token}
        serverUrl={livekitUrlForBrowser(serverUrl)}
        connect
        // People in the waiting room can't publish; media starts once admitted.
        audio={!joined.waiting && choices.audioEnabled}
        video={!joined.waiting && choices.videoEnabled}
        options={roomOptions}
        onDisconnected={onDisconnected}
        onError={(e) => setError(e.message)}
      >
        <MeetingContext.Provider value={{ roomName, token: joined.token }}>
          <ViewPrefsContext.Provider value={viewPrefs}>
            <ConferenceGate roomName={roomName} choices={choices} startWaiting={joined.waiting} />
          </ViewPrefsContext.Provider>
        </MeetingContext.Provider>
      </LiveKitRoom>
    </div>
  );
}

// Shows the waiting room until the host admits us, then the conference.
function ConferenceGate({
  roomName,
  choices,
  startWaiting,
}: {
  roomName: string;
  choices: LocalUserChoices;
  startWaiting: boolean;
}) {
  const { localParticipant } = useLocalParticipant();
  const connection = useConnectionState();
  useParticipantTick();
  // Until connected, trust the token response; afterwards the participant
  // attribute (cleared by the host on admit) is the source of truth.
  const waiting =
    connection === ConnectionState.Connected ? isWaiting(localParticipant) : startWaiting;
  const canPublish = localParticipant.permissions?.canPublish ?? false;
  const wasWaiting = useRef(startWaiting);

  // Admitted from the waiting room: turn on the mic/camera chosen on the
  // pre-join screen once the publish permission has arrived.
  useEffect(() => {
    if (waiting) {
      wasWaiting.current = true;
      return;
    }
    if (!wasWaiting.current || !canPublish) return;
    wasWaiting.current = false;
    if (choices.audioEnabled) localParticipant.setMicrophoneEnabled(true).catch(() => {});
    if (choices.videoEnabled) localParticipant.setCameraEnabled(true).catch(() => {});
  }, [waiting, canPublish, choices, localParticipant]);

  if (waiting) return <WaitingRoom roomName={roomName} />;
  return (
    <>
      <VideoConference SettingsComponent={SettingsPanel} />
      <MeetingExtras />
    </>
  );
}

function WaitingRoom({ roomName }: { roomName: string }) {
  const { admitted } = useRoles();
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  return (
    <main
      className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
      style={{ background: "#0b1120", color: "#e2e8f0" }}
      data-testid="waiting-room"
    >
      <div className="text-5xl">⏳</div>
      <h1 className="text-2xl font-semibold">
        {admitted.length === 0 ? "Waiting for the host to start this meeting" : "Please wait"}
      </h1>
      <p className="max-w-md text-[#94a3b8]">
        {admitted.length === 0
          ? "You'll be let in once the host joins and admits you."
          : "The meeting host will let you in soon."}
      </p>
      <p className="text-sm text-[#64748b]">
        {roomName} · joining as {localParticipant.name || localParticipant.identity}
      </p>
      <button
        onClick={() => room.disconnect()}
        className="mt-2 rounded-xl border border-white/20 px-5 py-2.5 font-medium transition hover:bg-white/10"
      >
        Leave
      </button>
    </main>
  );
}
