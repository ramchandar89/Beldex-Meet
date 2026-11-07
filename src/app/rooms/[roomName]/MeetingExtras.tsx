"use client";

// Zoom-style in-call extras layered over LiveKit's <VideoConference />:
//   - meeting info (code, duration, invite link / invitation)
//   - emoji reactions (ephemeral, over the data channel)
//   - raise / lower hand (persistent, via participant attributes)
//   - participants panel with waiting room and host controls (ParticipantsPanel)
//   - private (1:1) chat, "ask to unmute / start video" prompts
//   - floating self view, "you are sharing your screen" banner
//   - join / leave / waiting-room notifications, end meeting for all
//
// Roles are derived locally for display (see meeting.ts); the server
// independently re-verifies them before performing any privileged action.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  VideoTrack,
  useDataChannel,
  useLocalParticipant,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, Track, type Participant } from "livekit-client";

import ParticipantsPanel from "./ParticipantsPanel";
import {
  CONTROL_TOPIC,
  DM_TOPIC,
  HAND,
  REACTION_TOPIC,
  displayName,
  formatDuration,
  isWaiting,
  useHostApi,
  useMeeting,
  useRoles,
  useViewPrefs,
} from "./meeting";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "👏", "😮", "🙏"];

type FloatingReaction = { id: number; emoji: string; left: number };
type DirectMessage = { id: number; from: string; to: string; text: string; ts: number };
type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
type DialogState =
  | { kind: "rename"; target: Participant }
  | { kind: "end" }
  | { kind: "ask"; from: string; what: "unmute" | "video" }
  | null;

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

export default function MeetingExtras() {
  const room = useRoomContext();
  const { roomName } = useMeeting();
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const roles = useRoles();
  const { settings, admitted, waiting, raisedHands, privileged, isHost } = roles;
  const api = useHostApi();
  const me = localParticipant.identity;
  const iRaisedHand = raisedHands.has(me);

  const [panel, setPanel] = useState<"people" | "dm" | null>(null);
  const [showReactions, setShowReactions] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [dmPeer, setDmPeer] = useState<string>("");
  const [unreadDm, setUnreadDm] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const nextId = useRef(1);

  const byIdentity = useCallback(
    (id: string) => admitted.find((p) => p.identity === id) ?? room.getParticipantByIdentity(id),
    [admitted, room],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 10000 : 4000);
  }, []);

  /* ------------------------------ reactions ------------------------------ */

  // Receive reactions from others and float them up briefly.
  const spawn = useCallback((emoji: string) => {
    const id = nextId.current++;
    const left = 10 + Math.random() * 80;
    setFloating((f) => [...f, { id, emoji, left }]);
    setTimeout(() => setFloating((f) => f.filter((r) => r.id !== id)), 4000);
  }, []);

  const { send: sendReactionData } = useDataChannel(REACTION_TOPIC, (msg) => {
    try {
      const data = decode(msg.payload) as { emoji?: string };
      if (data.emoji) spawn(data.emoji);
    } catch {
      /* ignore malformed */
    }
  });

  const sendReaction = useCallback(
    async (emoji: string) => {
      spawn(emoji); // show our own immediately
      setShowReactions(false);
      try {
        await sendReactionData(encode({ emoji }), { reliable: true, topic: REACTION_TOPIC });
      } catch {
        /* best effort */
      }
    },
    [sendReactionData, spawn],
  );

  const toggleHand = useCallback(async () => {
    try {
      await localParticipant.setAttributes({ handRaised: iRaisedHand ? "" : "true" });
    } catch {
      /* ignore */
    }
  }, [localParticipant, iRaisedHand]);

  /* --------------------- host requests (ask to unmute) -------------------- */

  const { send: sendControl } = useDataChannel(CONTROL_TOPIC, (msg) => {
    const from = msg.from?.identity;
    // Only honour requests from the current host / co-hosts.
    if (!from || roles.roleOf(from) === null) return;
    try {
      const data = decode(msg.payload) as { type?: string };
      if (data.type === "ask-unmute") setDialog({ kind: "ask", from, what: "unmute" });
      if (data.type === "ask-video") setDialog({ kind: "ask", from, what: "video" });
    } catch {
      /* ignore malformed */
    }
  });

  const askTo = useCallback(
    async (identity: string, what: "unmute" | "video") => {
      try {
        await sendControl(encode({ type: what === "unmute" ? "ask-unmute" : "ask-video" }), {
          reliable: true,
          topic: CONTROL_TOPIC,
          destinationIdentities: [identity],
        });
        toast(`Asked ${displayName(byIdentity(identity))} to ${what === "unmute" ? "unmute" : "start video"}`);
      } catch {
        toast("Couldn't send the request");
      }
    },
    [sendControl, toast, byIdentity],
  );

  /* ---------------------------- private chat ----------------------------- */

  const panelRef = useRef(panel);
  panelRef.current = panel;

  const { send: sendDmData } = useDataChannel(DM_TOPIC, (msg) => {
    const from = msg.from?.identity;
    if (!from) return;
    try {
      const data = decode(msg.payload) as { text?: string };
      if (!data.text) return;
      setDms((d) => [...d, { id: nextId.current++, from, to: me, text: data.text!, ts: Date.now() }]);
      if (panelRef.current !== "dm") {
        setUnreadDm((n) => n + 1);
        toast(`Private message from ${displayName(byIdentity(from))}`, {
          label: "Reply",
          run: () => openDm(from),
        });
      }
    } catch {
      /* ignore malformed */
    }
  });

  const sendDm = useCallback(
    async (to: string, text: string) => {
      await sendDmData(encode({ text }), { reliable: true, topic: DM_TOPIC, destinationIdentities: [to] });
      setDms((d) => [...d, { id: nextId.current++, from: me, to, text, ts: Date.now() }]);
    },
    [sendDmData, me],
  );

  const openDm = useCallback((identity?: string) => {
    if (identity) setDmPeer(identity);
    setUnreadDm(0);
    setPanel("dm");
  }, []);

  /* --------------------------- notifications ----------------------------- */

  const rolesRef = useRef(roles);
  rolesRef.current = roles;

  useEffect(() => {
    const onJoin = (p: Participant) => {
      if (isWaiting(p)) {
        if (rolesRef.current.privileged) {
          toast(`${displayName(p)} is in the waiting room`, {
            label: "Admit",
            run: () => api("admit", { target: p.identity }).catch(() => {}),
          });
        }
      } else {
        toast(`${displayName(p)} joined`);
      }
    };
    const onLeave = (p: Participant) => {
      if (!isWaiting(p)) toast(`${displayName(p)} left`);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room, toast, api]);

  // Announce role changes that affect us (not the initial role of whoever
  // starts the meeting).
  const prevRole = useRef<string | null>(null);
  const myRole = roles.roleOf(me) ?? "";
  const othersHere = admitted.length > 1;
  useEffect(() => {
    if (prevRole.current !== null && othersHere && myRole !== prevRole.current) {
      if (myRole === "host") toast("You are now the host");
      if (myRole === "cohost") toast("You are now a co-host");
    }
    prevRole.current = myRole;
  }, [myRole, othersHere, toast]);

  // If we became host/co-host while our publish rights were restricted (e.g.
  // the host left and the role fell to us), ask the server to re-apply them.
  const synced = useRef(false);
  const perms = localParticipant.permissions;
  useEffect(() => {
    if (!privileged || !perms) {
      synced.current = false;
      return;
    }
    const restricted = !perms.canPublishData || (perms.canPublishSources?.length ?? 0) < 4;
    if (restricted && !synced.current) {
      synced.current = true;
      api("settings").catch(() => {
        synced.current = false;
      });
    }
  }, [privileged, perms, roles.tick, api]);

  /* ------------------------------- invite -------------------------------- */

  const joinUrl = typeof window !== "undefined" ? `${window.location.origin}/rooms/${encodeURIComponent(roomName)}` : "";
  const invitation = `${displayName(localParticipant)} is inviting you to a Beldex Meet meeting.\n\nJoin: ${joinUrl}\nMeeting code: ${roomName}`;

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${label} copied`);
      } catch {
        toast("Couldn't access the clipboard");
      }
    },
    [toast],
  );

  const invite = useCallback(async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Join my Beldex Meet", text: invitation, url: joinUrl });
        return;
      } catch {
        /* cancelled or unsupported — fall back to copying */
      }
    }
    copy(invitation, "Invitation");
  }, [invitation, joinUrl, copy]);

  /* -------------------------------- render ------------------------------- */

  const raisedList = admitted.filter((p) => raisedHands.has(p.identity));
  const restrictedAudio = !privileged && !settings.allowUnmute;
  const chatBlocked = !privileged && !settings.allowChat;

  return (
    <>
      {/* Inlined (not globals.css) because Tailwind's CSS pipeline strips these rules. */}
      <style>{OVERLAY_CSS}</style>
      {/* Chat disabled by the host: hide the built-in chat composer. */}
      {chatBlocked && (
        <style>{`.lk-chat-form { display: none !important; }
          .lk-chat-messages::after { content: "The host has disabled chat"; display: block; padding: 12px; opacity: .7; text-align: center; }`}</style>
      )}

      {/* Floating reactions — non-interactive overlay across the whole stage. */}
      <div style={styles.floatLayer} aria-hidden>
        {floating.map((r) => (
          <span key={r.id} style={{ ...styles.floatEmoji, left: `${r.left}%` }}>
            {r.emoji}
          </span>
        ))}
      </div>

      {/* Meeting info chip, top-left. */}
      <div style={styles.infoWrap}>
        <button
          style={styles.infoChip}
          onClick={() => setShowInfo((v) => !v)}
          title="Meeting information"
          data-testid="meeting-info"
        >
          <span>{settings.locked ? "🔒" : "🛡️"}</span>
          <span className="bm-hide-narrow">{roomName}</span>
          <span style={styles.timer}>{formatDuration(now - startedAt)}</span>
        </button>
        {showInfo && (
          <div style={styles.infoPop}>
            <div style={styles.infoTitle}>{roomName}</div>
            <InfoRow label="Meeting code" value={roomName} />
            <InfoRow label="Host" value={displayName(byIdentity(roles.hostIdentity ?? ""))} />
            <InfoRow label="Invite link" value={joinUrl} />
            <InfoRow
              label="Security"
              value={
                [settings.locked && "Locked", settings.waitingRoom && "Waiting room on"]
                  .filter(Boolean)
                  .join(" · ") || "Open"
              }
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button style={styles.popBtn} onClick={() => copy(joinUrl, "Invite link")}>
                Copy link
              </button>
              <button style={styles.popBtn} onClick={() => copy(invitation, "Invitation")}>
                Copy invitation
              </button>
              <a
                style={{ ...styles.popBtn, textDecoration: "none" }}
                href={`mailto:?subject=${encodeURIComponent("Join my Beldex Meet")}&body=${encodeURIComponent(invitation)}`}
              >
                Email
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Status banners, top-center. */}
      <div style={styles.banners} className="bm-banners">
        {settings.locked && (
          <div style={{ ...styles.banner, background: "rgba(220,38,38,0.9)" }}>🔒 Room locked</div>
        )}
        {raisedList.length > 0 && (
          <div style={styles.banner}>
            {HAND} {raisedList.map(displayName).join(", ")}
          </div>
        )}
        {isScreenShareEnabled && (
          <div style={{ ...styles.banner, background: "rgba(22,163,74,0.95)", pointerEvents: "auto" }}>
            You are sharing your screen ·{" "}
            <button
              style={styles.bannerBtn}
              onClick={() => localParticipant.setScreenShareEnabled(false).catch(() => {})}
            >
              Stop share
            </button>
          </div>
        )}
        {restrictedAudio && (
          <div style={{ ...styles.banner, background: "rgba(30,41,59,0.95)" }}>
            🔇 The host has disabled unmuting
          </div>
        )}
      </div>

      {/* Button cluster, top-right. */}
      <div
        style={{ ...styles.cluster, ...(panel ? { right: "calc(min(380px, 100vw) + 12px)" } : {}) }}
        className="bm-cluster"
      >
        <button
          style={styles.clusterBtn}
          onClick={() => setPanel((p) => (p === "people" ? null : "people"))}
          title="Participants"
          aria-label="Participants"
        >
          👥
          <span style={styles.count}>{admitted.length}</span>
          {privileged && waiting.length > 0 && <span style={styles.badge}>{waiting.length}</span>}
        </button>
        <button
          style={styles.clusterBtn}
          onClick={() => (panel === "dm" ? setPanel(null) : openDm())}
          title="Private messages"
          aria-label="Private messages"
        >
          ✉️
          {unreadDm > 0 && <span style={styles.badge}>{unreadDm}</span>}
        </button>
        <button
          style={{ ...styles.clusterBtn, ...(iRaisedHand ? styles.clusterBtnActive : {}) }}
          onClick={toggleHand}
          title={iRaisedHand ? "Lower hand" : "Raise hand"}
          aria-label={iRaisedHand ? "Lower hand" : "Raise hand"}
        >
          {HAND}
        </button>
        <div style={{ position: "relative" }}>
          <button
            style={styles.clusterBtn}
            onClick={() => setShowReactions((v) => !v)}
            title="React"
            aria-label="React"
            disabled={chatBlocked}
          >
            🙂
          </button>
          {showReactions && (
            <div style={styles.reactRow}>
              {REACTIONS.map((e) => (
                <button key={e} style={styles.reactBtn} onClick={() => sendReaction(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <button style={styles.clusterBtn} onClick={invite} title="Invite" aria-label="Invite">
          ➕
        </button>
        {isHost && (
          <button
            style={{ ...styles.clusterBtn, ...styles.endBtn }}
            onClick={() => setDialog({ kind: "end" })}
            title="End meeting"
          >
            End
          </button>
        )}
      </div>

      {panel === "people" && (
        <ParticipantsPanel
          roles={roles}
          onClose={() => setPanel(null)}
          onMessage={(id) => openDm(id)}
          onRename={(p) => setDialog({ kind: "rename", target: p })}
          onInvite={invite}
          onEndMeeting={() => setDialog({ kind: "end" })}
          askTo={askTo}
        />
      )}

      {panel === "dm" && (
        <PrivateChat
          me={me}
          peers={admitted.filter((p) => p.identity !== me)}
          peer={dmPeer}
          setPeer={setDmPeer}
          messages={dms}
          nameOf={(id) => (id === me ? "You" : displayName(byIdentity(id)))}
          blocked={chatBlocked}
          onSend={sendDm}
          onClose={() => setPanel(null)}
        />
      )}

      <SelfView />

      {/* Notifications, bottom-left above the control bar. */}
      <div style={styles.toasts} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} style={styles.toast}>
            <span>{t.text}</span>
            {t.action && (
              <button
                style={styles.toastBtn}
                onClick={() => {
                  t.action!.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {dialog?.kind === "rename" && (
        <RenameDialog
          target={dialog.target}
          onClose={() => setDialog(null)}
          onSave={(name) => api("rename", { target: dialog.target.identity, name })}
        />
      )}
      {dialog?.kind === "end" && (
        <Dialog title="End this meeting?" onClose={() => setDialog(null)}>
          <p style={styles.dialogText}>
            Everyone will be disconnected. To leave without ending it, use Leave — the host role passes
            to someone else.
          </p>
          <div style={styles.dialogBtns}>
            <button
              style={{ ...styles.dialogBtn, ...styles.dangerBtn }}
              onClick={() => {
                setDialog(null);
                api("end").catch((e) => toast(e instanceof Error ? e.message : "Couldn't end meeting"));
              }}
            >
              End meeting for all
            </button>
            <button
              style={styles.dialogBtn}
              onClick={() => {
                setDialog(null);
                room.disconnect();
              }}
            >
              Leave meeting
            </button>
            <button style={styles.dialogBtn} onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
      {dialog?.kind === "ask" && (
        <Dialog
          title={`${displayName(byIdentity(dialog.from))} is asking you to ${dialog.what === "unmute" ? "unmute" : "start your video"}`}
          onClose={() => setDialog(null)}
        >
          <div style={styles.dialogBtns}>
            <button
              style={{ ...styles.dialogBtn, ...styles.primaryBtn }}
              onClick={() => {
                const what = dialog.what;
                setDialog(null);
                (what === "unmute"
                  ? localParticipant.setMicrophoneEnabled(true)
                  : localParticipant.setCameraEnabled(true)
                ).catch((e) => toast(e instanceof Error ? e.message : "Couldn't turn it on"));
              }}
            >
              {dialog.what === "unmute" ? "Unmute" : "Start video"}
            </button>
            <button style={styles.dialogBtn} onClick={() => setDialog(null)}>
              {dialog.what === "unmute" ? "Stay muted" : "Later"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/* ------------------------------- sub-views -------------------------------- */

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: "break-all", userSelect: "all" }}>{value}</div>
    </div>
  );
}

// Floating, draggable self view (the grid only shows other participants).
function SelfView() {
  const { localParticipant, cameraTrack, isCameraEnabled } = useLocalParticipant();
  const { prefs, setPrefs } = useViewPrefs();
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 16, bottom: 96 });
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);

  const trackRef = useMemo(
    () =>
      cameraTrack
        ? { participant: localParticipant, source: Track.Source.Camera, publication: cameraTrack }
        : undefined,
    [localParticipant, cameraTrack],
  );

  if (!prefs.showSelfView) return null;

  return (
    <div
      style={{ ...styles.selfView, right: pos.right, bottom: pos.bottom }}
      className="bm-selfview"
      data-testid="self-view"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, ...pos };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setPos({
          right: Math.max(0, d.right - (e.clientX - d.x)),
          bottom: Math.max(0, d.bottom - (e.clientY - d.y)),
        });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      {trackRef && isCameraEnabled ? (
        <VideoTrack
          trackRef={trackRef}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: prefs.mirrorSelf ? "scaleX(-1)" : undefined,
          }}
        />
      ) : (
        <div style={styles.selfAvatar}>{displayName(localParticipant).charAt(0).toUpperCase()}</div>
      )}
      <span style={styles.selfName}>
        {displayName(localParticipant)} (you){localParticipant.isMicrophoneEnabled ? "" : " 🔇"}
      </span>
      <button
        style={styles.selfHide}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setPrefs({ showSelfView: false })}
        title="Hide self view"
        aria-label="Hide self view"
      >
        ✕
      </button>
    </div>
  );
}

function PrivateChat({
  me,
  peers,
  peer,
  setPeer,
  messages,
  nameOf,
  blocked,
  onSend,
  onClose,
}: {
  me: string;
  peers: Participant[];
  peer: string;
  setPeer: (id: string) => void;
  messages: DirectMessage[];
  nameOf: (id: string) => string;
  blocked: boolean;
  onSend: (to: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const to = peers.some((p) => p.identity === peer) ? peer : (peers[0]?.identity ?? "");

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !to) return;
    setError(null);
    try {
      await onSend(to, text);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message not sent");
    }
  };

  return (
    <div style={styles.panel} className="bm-panel" role="dialog" aria-label="Private messages">
      <div style={styles.panelHead}>
        <strong>Private messages</strong>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close private messages">
          ✕
        </button>
      </div>
      <div ref={listRef} style={styles.dmList}>
        {messages.length === 0 && (
          <p style={{ color: "#64748b", textAlign: "center", marginTop: 24, fontSize: 13 }}>
            Messages here are only seen by you and the person you send them to.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ ...styles.dm, ...(m.from === me ? styles.dmMine : {}) }}>
            <div style={styles.dmMeta}>
              {m.from === me ? `You → ${nameOf(m.to)}` : `${nameOf(m.from)} → You`} ·{" "}
              {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
      {blocked ? (
        <p style={{ ...styles.dmMeta, padding: 16, textAlign: "center" }}>The host has disabled chat</p>
      ) : peers.length === 0 ? (
        <p style={{ ...styles.dmMeta, padding: 16, textAlign: "center" }}>Nobody else is here yet</p>
      ) : (
        <form onSubmit={submit} style={styles.dmForm}>
          <label style={{ fontSize: 12, color: "#94a3b8" }}>
            To{" "}
            <select
              value={to}
              onChange={(e) => setPeer(e.target.value)}
              style={styles.dmSelect}
              aria-label="Recipient"
            >
              {peers.map((p) => (
                <option key={p.identity} value={p.identity}>
                  {displayName(p)}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Private message"
              style={styles.dmInput}
              aria-label="Private message"
            />
            <button type="submit" style={{ ...styles.dialogBtn, ...styles.primaryBtn }}>
              Send
            </button>
          </div>
          {error && <span style={{ color: "#f87171", fontSize: 12 }}>{error}</span>}
        </form>
      )}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <strong style={{ fontSize: 16 }}>{title}</strong>
        {children}
      </div>
    </div>
  );
}

function RenameDialog({
  target,
  onClose,
  onSave,
}: {
  target: Participant;
  onClose: () => void;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(displayName(target));
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Rename" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSave(name);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Rename failed");
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={styles.dmInput}
          aria-label="New name"
          maxLength={64}
        />
        {error && <span style={{ color: "#f87171", fontSize: 12 }}>{error}</span>}
        <div style={styles.dialogBtns}>
          <button type="submit" style={{ ...styles.dialogBtn, ...styles.primaryBtn }}>
            Save
          </button>
          <button type="button" style={styles.dialogBtn} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* --------------------------------- styles ---------------------------------- */

// Reaction animation + phone-width layout for the overlay and LiveKit's control bar.
const OVERLAY_CSS = `
@keyframes veilFloat {
  0% { transform: translateY(0) scale(0.6); opacity: 0; }
  15% { opacity: 1; }
  100% { transform: translateY(-55vh) scale(1.2); opacity: 0; }
}
@media (max-width: 640px) {
  .bm-hide-narrow { display: none; }
  .bm-cluster { gap: 4px !important; top: 8px !important; right: 8px !important; }
  .bm-cluster > button, .bm-cluster > div > button { padding: 6px 7px !important; font-size: 15px !important; }
  .bm-banners { top: 56px !important; max-width: 94% !important; }
  .bm-selfview { width: 104px !important; aspect-ratio: 3 / 4 !important; }
  .lk-control-bar { gap: 4px !important; padding: 6px !important; flex-wrap: wrap; justify-content: center; }
  .lk-control-bar .lk-button { padding: 8px 10px !important; }
}
`;

const styles: Record<string, React.CSSProperties> = {
  floatLayer: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    overflow: "hidden",
    zIndex: 40,
  },
  floatEmoji: {
    position: "absolute",
    bottom: 90,
    fontSize: 40,
    animation: "veilFloat 4s ease-out forwards",
  },
  infoWrap: { position: "absolute", top: 12, left: 12, zIndex: 46 },
  infoChip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(17,24,39,0.8)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    backdropFilter: "blur(6px)",
  },
  timer: { fontVariantNumeric: "tabular-nums", color: "#a5b4fc" },
  infoPop: {
    position: "absolute",
    top: "110%",
    left: 0,
    width: "min(340px, calc(100vw - 24px))",
    background: "#0f172a",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 12,
    padding: 14,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  infoTitle: { fontWeight: 700, fontSize: 15 },
  popBtn: {
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  banners: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 45,
    alignItems: "center",
    pointerEvents: "none",
    maxWidth: "80%",
  },
  banner: {
    background: "rgba(79,70,229,0.92)",
    color: "#fff",
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
  },
  bannerBtn: {
    background: "#fff",
    color: "#166534",
    border: "none",
    borderRadius: 999,
    padding: "2px 10px",
    fontWeight: 700,
    cursor: "pointer",
  },
  cluster: {
    position: "absolute",
    top: 12,
    right: 12,
    display: "flex",
    gap: 8,
    zIndex: 45,
  },
  clusterBtn: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "rgba(17,24,39,0.8)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 18,
    cursor: "pointer",
    backdropFilter: "blur(6px)",
  },
  clusterBtnActive: { background: "#4f46e5", borderColor: "#6366f1" },
  endBtn: { background: "#dc2626", borderColor: "#ef4444", fontSize: 14, fontWeight: 700 },
  count: { fontSize: 13, fontWeight: 700 },
  badge: {
    position: "absolute",
    top: -6,
    right: -6,
    background: "#ef4444",
    color: "#fff",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    minWidth: 18,
    height: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 4px",
  },
  reactRow: {
    position: "absolute",
    top: "110%",
    right: 0,
    display: "flex",
    gap: 4,
    background: "rgba(17,24,39,0.95)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: 6,
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
  },
  reactBtn: {
    background: "transparent",
    border: "none",
    fontSize: 24,
    cursor: "pointer",
    padding: "2px 4px",
    lineHeight: 1,
  },
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(360px, 100vw)",
    background: "#0f172a",
    color: "#e2e8f0",
    borderLeft: "1px solid #1e293b",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    boxShadow: "-4px 0 20px rgba(0,0,0,0.4)",
  },
  panelHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid #1e293b",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: 18,
    cursor: "pointer",
  },
  dmList: { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  dm: { background: "#1e293b", borderRadius: 10, padding: "8px 10px", fontSize: 14, alignSelf: "flex-start", maxWidth: "85%" },
  dmMine: { background: "#312e81", alignSelf: "flex-end" },
  dmMeta: { fontSize: 11, color: "#94a3b8", marginBottom: 2 },
  dmForm: { display: "flex", flexDirection: "column", gap: 8, padding: 12, borderTop: "1px solid #1e293b" },
  dmSelect: {
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "4px 6px",
    marginLeft: 4,
  },
  dmInput: {
    flex: 1,
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "9px 12px",
    fontSize: 14,
    outline: "none",
  },
  selfView: {
    position: "absolute",
    width: 200,
    aspectRatio: "16 / 10",
    background: "#1e293b",
    borderRadius: 12,
    overflow: "hidden",
    zIndex: 44,
    border: "2px solid rgba(255,255,255,0.2)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
    cursor: "grab",
    touchAction: "none",
  },
  selfAvatar: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 32,
    fontWeight: 700,
    color: "#e2e8f0",
  },
  selfName: {
    position: "absolute",
    left: 6,
    bottom: 6,
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 6,
  },
  selfHide: {
    position: "absolute",
    top: 4,
    right: 4,
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    border: "none",
    borderRadius: 999,
    width: 22,
    height: 22,
    fontSize: 11,
    cursor: "pointer",
  },
  toasts: {
    position: "absolute",
    left: 12,
    bottom: 90,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 55,
    maxWidth: "min(360px, calc(100vw - 24px))",
  },
  toast: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "rgba(15,23,42,0.95)",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 13,
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
  },
  toastBtn: {
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "4px 10px",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
  },
  backdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 70,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  dialog: {
    background: "#0f172a",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 14,
    padding: 20,
    width: "min(420px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  dialogText: { margin: 0, fontSize: 14, color: "#94a3b8" },
  dialogBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  dialogBtn: {
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "8px 14px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  primaryBtn: { background: "#4f46e5", borderColor: "#6366f1" },
  dangerBtn: { background: "#dc2626", borderColor: "#ef4444" },
};
