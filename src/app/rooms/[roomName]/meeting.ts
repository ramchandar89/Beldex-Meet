"use client";

// Shared in-call state for the web client: meeting settings (room metadata),
// roles (host / co-host / waiting), view preferences, and the authenticated
// host-control API. The server applies the same rules (src/lib/roomAdmin.ts)
// and re-verifies everything before acting.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocalParticipant, useParticipants, useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";

export const HAND = "✋";
export const REACTION_TOPIC = "veil-reactions";
// Host -> participant requests ("please unmute"), and private chat messages.
export const CONTROL_TOPIC = "beldex-control";
export const DM_TOPIC = "beldex-dm";

/* -------------------------------- settings -------------------------------- */

export type RoomSettings = {
  locked: boolean;
  waitingRoom: boolean;
  allowChat: boolean;
  allowScreenShare: boolean;
  allowUnmute: boolean;
  allowVideo: boolean;
  allowRename: boolean;
  host?: string;
  cohosts: string[];
};

const DEFAULT_SETTINGS: RoomSettings = {
  locked: false,
  waitingRoom: false,
  allowChat: true,
  allowScreenShare: true,
  allowUnmute: true,
  allowVideo: true,
  allowRename: true,
  cohosts: [],
};

function parseSettings(meta?: string): RoomSettings {
  if (!meta) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(meta);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      cohosts: Array.isArray(parsed?.cohosts) ? parsed.cohosts : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Meeting settings, read from the room metadata LiveKit broadcasts to everyone.
export function useRoomSettings(): RoomSettings {
  const room = useRoomContext();
  const [settings, setSettings] = useState(() => parseSettings(room.metadata));
  useEffect(() => {
    const onChange = () => setSettings(parseSettings(room.metadata));
    onChange();
    room.on(RoomEvent.RoomMetadataChanged, onChange);
    return () => {
      room.off(RoomEvent.RoomMetadataChanged, onChange);
    };
  }, [room]);
  return settings;
}

/* ---------------------------------- roles --------------------------------- */

export function isWaiting(p: Participant): boolean {
  return p.attributes?.waiting === "true";
}

// Re-render on participant changes that don't alter the roster itself
// (attributes, names, permissions, mute state).
export function useParticipantTick(): number {
  const room = useRoomContext();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const events = [
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.ParticipantNameChanged,
      RoomEvent.ParticipantPermissionsChanged,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
    ] as const;
    events.forEach((e) => room.on(e, bump));
    return () => {
      events.forEach((e) => room.off(e, bump));
    };
  }, [room]);
  return tick;
}

// Same rule as the server: explicit host if present, then the first co-host
// present, then the earliest-joined admitted participant (ties by identity).
function hostIdentityOf(admitted: Participant[], settings: RoomSettings): string | null {
  if (admitted.length === 0) return null;
  const present = (id?: string) => admitted.some((p) => p.identity === id);
  if (present(settings.host)) return settings.host!;
  const cohost = settings.cohosts.find(present);
  if (cohost) return cohost;
  return [...admitted].sort((a, b) => {
    const ja = a.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const jb = b.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ja !== jb) return ja - jb;
    return a.identity < b.identity ? -1 : 1;
  })[0].identity;
}

export type Roles = {
  settings: RoomSettings;
  admitted: Participant[];
  waiting: Participant[];
  hostIdentity: string | null;
  isHost: boolean;
  isCohost: boolean;
  // Host or co-host.
  privileged: boolean;
  raisedHands: Set<string>;
  roleOf: (identity: string) => "host" | "cohost" | null;
  tick: number;
};

export function useRoles(): Roles {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const settings = useRoomSettings();
  const tick = useParticipantTick();

  return useMemo(() => {
    const admitted = participants.filter((p) => !isWaiting(p));
    const waiting = participants.filter(isWaiting);
    const hostIdentity = hostIdentityOf(admitted, settings);
    const me = localParticipant.identity;
    const isHost = hostIdentity === me;
    const isCohost = !isHost && settings.cohosts.includes(me);
    const raisedHands = new Set(
      admitted.filter((p) => p.attributes?.handRaised === "true").map((p) => p.identity),
    );
    const roleOf = (id: string) =>
      id === hostIdentity ? ("host" as const) : settings.cohosts.includes(id) ? ("cohost" as const) : null;
    return {
      settings,
      admitted,
      waiting,
      hostIdentity,
      isHost,
      isCohost,
      privileged: isHost || isCohost,
      raisedHands,
      roleOf,
      tick,
    };
    // `tick` forces recompute on attribute/permission changes that don't alter `participants`.
  }, [participants, localParticipant.identity, settings, tick]);
}

/* ------------------------------ meeting context ---------------------------- */

export type MeetingInfo = { roomName: string; token: string };

export const MeetingContext = createContext<MeetingInfo | null>(null);

export function useMeeting(): MeetingInfo {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error("useMeeting must be used inside <MeetingContext.Provider>");
  return ctx;
}

// POST to a host-control endpoint, authenticated with our own join token.
// Throws with the server's message on failure.
export function useHostApi() {
  const { roomName, token } = useMeeting();
  return useCallback(
    async (path: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`/api/room/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ room: roomName, ...extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      return body as Record<string, unknown>;
    },
    [roomName, token],
  );
}

/* ----------------------------- view preferences ---------------------------- */

export type ViewPrefs = { showSelfView: boolean; mirrorSelf: boolean };

const PREFS_KEY = "beldex-meet-view-prefs";

export const ViewPrefsContext = createContext<{
  prefs: ViewPrefs;
  setPrefs: (p: Partial<ViewPrefs>) => void;
} | null>(null);

export function useViewPrefsState() {
  const [prefs, setState] = useState<ViewPrefs>({ showSelfView: true, mirrorSelf: true });
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) setState((p) => ({ ...p, ...JSON.parse(raw) }));
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setPrefs = useCallback((patch: Partial<ViewPrefs>) => {
    setState((p) => {
      const next = { ...p, ...patch };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);
  return { prefs, setPrefs };
}

export function useViewPrefs() {
  const ctx = useContext(ViewPrefsContext);
  if (!ctx) throw new Error("useViewPrefs must be used inside <ViewPrefsContext.Provider>");
  return ctx;
}

/* ---------------------------------- misc ---------------------------------- */

export function displayName(p: Participant | undefined): string {
  return p?.name || p?.identity || "Guest";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
