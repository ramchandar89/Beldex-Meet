"use client";

// Zoom-style participants panel: waiting room (admit / deny), everyone in the
// meeting with their role, hand, mic and camera state, per-person host actions
// (mute / ask to unmute, stop video, rename, make host / co-host, remove,
// private message) and the meeting-wide "Allow participants to …" toggles.

import { useState } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { HAND, displayName, useHostApi, type Roles, type RoomSettings } from "./meeting";

type Props = {
  roles: Roles;
  onClose: () => void;
  onMessage: (identity: string) => void;
  onRename: (p: Participant) => void;
  onInvite: () => void;
  onEndMeeting: () => void;
  askTo: (identity: string, kind: "unmute" | "video") => void;
};

const PERMISSIONS: { key: keyof RoomSettings; label: string }[] = [
  { key: "allowUnmute", label: "Unmute themselves" },
  { key: "allowVideo", label: "Start video" },
  { key: "allowScreenShare", label: "Share screen" },
  { key: "allowChat", label: "Chat & react" },
  { key: "allowRename", label: "Rename themselves" },
];

export default function ParticipantsPanel({
  roles,
  onClose,
  onMessage,
  onRename,
  onInvite,
  onEndMeeting,
  askTo,
}: Props) {
  const { localParticipant } = useLocalParticipant();
  const api = useHostApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const { settings, admitted, waiting, hostIdentity, isHost, privileged, raisedHands, roleOf } = roles;
  const me = localParticipant.identity;

  const act = async (path: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    setMenuFor(null);
    try {
      await api(path, extra);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  // You first, then the host, co-hosts, raised hands, then by name.
  const rank = (p: Participant) =>
    p.identity === me ? 0 : p.identity === hostIdentity ? 1 : roleOf(p.identity) ? 2 : raisedHands.has(p.identity) ? 3 : 4;
  const sorted = [...admitted].sort(
    (a, b) => rank(a) - rank(b) || displayName(a).localeCompare(displayName(b)),
  );

  return (
    <div style={s.panel} className="bm-panel" role="dialog" aria-label="Participants">
      <div style={s.head}>
        <strong>Participants ({admitted.length})</strong>
        <button style={s.close} onClick={onClose} aria-label="Close participants">
          ✕
        </button>
      </div>

      {privileged && (
        <div style={s.hostBar}>
          <button style={s.hostBtn} disabled={busy} onClick={() => act("mute")}>
            Mute all
          </button>
          {raisedHands.size > 0 && (
            <button style={s.hostBtn} disabled={busy} onClick={() => act("hands")}>
              Lower all hands
            </button>
          )}
          <button
            style={{ ...s.hostBtn, ...(settings.locked ? s.hostBtnOn : {}) }}
            disabled={busy}
            onClick={() => act("lock", { locked: !settings.locked })}
          >
            {settings.locked ? "Unlock room" : "Lock room"}
          </button>
          {isHost && (
            <button style={{ ...s.hostBtn, ...s.hostBtnOn }} disabled={busy} onClick={onEndMeeting}>
              End meeting
            </button>
          )}
        </div>
      )}
      {error && <p style={s.error}>{error}</p>}

      <div style={s.scroll}>
        {privileged && waiting.length > 0 && (
          <section>
            <div style={s.sectionHead}>
              <span>Waiting room ({waiting.length})</span>
              <button style={s.linkBtn} disabled={busy} onClick={() => act("admit", { all: true })}>
                Admit all
              </button>
            </div>
            <ul style={s.list}>
              {waiting.map((p) => (
                <li key={p.identity} style={s.row}>
                  <span style={s.name}>{displayName(p)}</span>
                  <span style={s.actions}>
                    <button
                      style={{ ...s.mini, ...s.miniPrimary }}
                      disabled={busy}
                      onClick={() => act("admit", { target: p.identity })}
                    >
                      Admit
                    </button>
                    <button
                      style={{ ...s.mini, ...s.miniDanger }}
                      disabled={busy}
                      onClick={() => act("admit", { target: p.identity, deny: true })}
                    >
                      Deny
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          {privileged && waiting.length > 0 && (
            <div style={s.sectionHead}>
              <span>In the meeting ({admitted.length})</span>
            </div>
          )}
          <ul style={s.list}>
            {sorted.map((p) => {
              const you = p.identity === me;
              const role = roleOf(p.identity);
              const canManage = privileged && !you && !(role === "host" && !isHost);
              const micOn = p.isMicrophoneEnabled;
              const camOn = p.isCameraEnabled;
              return (
                <li key={p.identity} style={s.row} data-testid="participant-row">
                  <span style={s.name}>
                    <span style={s.avatar}>{displayName(p).charAt(0).toUpperCase()}</span>
                    <span style={s.nameText}>
                      {displayName(p)}
                      {you && " (you)"}
                    </span>
                    {role === "host" && <span style={s.tag}>HOST</span>}
                    {role === "cohost" && <span style={{ ...s.tag, ...s.tagCo }}>CO-HOST</span>}
                    {raisedHands.has(p.identity) && <span>{HAND}</span>}
                  </span>
                  <span style={s.actions}>
                    <span style={s.state} title={micOn ? "Mic on" : "Muted"}>
                      {micOn ? "🎙️" : "🔇"}
                    </span>
                    <span style={s.state} title={camOn ? "Camera on" : "Camera off"}>
                      {camOn ? "📹" : "🚫"}
                    </span>
                    {canManage &&
                      (micOn ? (
                        <button
                          style={s.mini}
                          disabled={busy}
                          onClick={() => act("mute", { target: p.identity })}
                        >
                          Mute
                        </button>
                      ) : (
                        <button style={s.mini} onClick={() => askTo(p.identity, "unmute")}>
                          Ask to unmute
                        </button>
                      ))}
                    {(canManage || you || !privileged) && (
                      <span style={{ position: "relative" }}>
                        <button
                          style={s.mini}
                          aria-label={`More actions for ${displayName(p)}`}
                          onClick={() => setMenuFor((m) => (m === p.identity ? null : p.identity))}
                        >
                          More ▾
                        </button>
                        {menuFor === p.identity && (
                          <div style={s.menu} role="menu">
                            {!you && (
                              <MenuItem
                                onClick={() => {
                                  setMenuFor(null);
                                  onMessage(p.identity);
                                }}
                              >
                                Message privately
                              </MenuItem>
                            )}
                            {(canManage || (you && (settings.allowRename || privileged))) && (
                              <MenuItem
                                onClick={() => {
                                  setMenuFor(null);
                                  onRename(p);
                                }}
                              >
                                Rename
                              </MenuItem>
                            )}
                            {canManage &&
                              (camOn ? (
                                <MenuItem
                                  onClick={() => act("mute", { target: p.identity, source: "camera" })}
                                >
                                  Stop video
                                </MenuItem>
                              ) : (
                                <MenuItem
                                  onClick={() => {
                                    setMenuFor(null);
                                    askTo(p.identity, "video");
                                  }}
                                >
                                  Ask to start video
                                </MenuItem>
                              ))}
                            {isHost && !you && (
                              <>
                                <MenuItem onClick={() => act("role", { target: p.identity, role: "host" })}>
                                  Make host
                                </MenuItem>
                                {role === "cohost" ? (
                                  <MenuItem
                                    onClick={() => act("role", { target: p.identity, role: "participant" })}
                                  >
                                    Remove co-host
                                  </MenuItem>
                                ) : (
                                  <MenuItem onClick={() => act("role", { target: p.identity, role: "cohost" })}>
                                    Make co-host
                                  </MenuItem>
                                )}
                              </>
                            )}
                            {canManage && (
                              <MenuItem danger onClick={() => act("remove", { target: p.identity })}>
                                Remove from meeting
                              </MenuItem>
                            )}
                          </div>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {privileged && (
          <section style={s.perms}>
            <div style={s.sectionHead}>
              <span>Security</span>
            </div>
            <Toggle
              label="Enable waiting room"
              checked={settings.waitingRoom}
              disabled={busy}
              onChange={(v) => act("settings", { waitingRoom: v })}
            />
            <div style={{ ...s.sectionHead, paddingTop: 10 }}>
              <span>Allow participants to</span>
            </div>
            {PERMISSIONS.map(({ key, label }) => (
              <Toggle
                key={key}
                label={label}
                checked={settings[key] as boolean}
                disabled={busy}
                onChange={(v) => act("settings", { [key]: v })}
              />
            ))}
          </section>
        )}
      </div>

      <div style={s.footer}>
        <button style={s.footerBtn} onClick={onInvite}>
          Invite
        </button>
        {!privileged && hostIdentity && (
          <button style={s.footerBtn} onClick={() => onMessage(hostIdentity)}>
            Message host
          </button>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button role="menuitem" style={{ ...s.menuItem, ...(danger ? { color: "#f87171" } : {}) }} onClick={onClick}>
      {children}
    </button>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={s.toggle}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: "#4f46e5" }}
      />
    </label>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: "min(380px, 100vw)",
    background: "#0f172a",
    color: "#e2e8f0",
    borderLeft: "1px solid #1e293b",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    boxShadow: "-4px 0 20px rgba(0,0,0,0.4)",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid #1e293b",
  },
  close: { background: "transparent", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer" },
  hostBar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    padding: "12px 16px",
    borderBottom: "1px solid #1e293b",
  },
  hostBtn: {
    flex: "1 1 40%",
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  hostBtnOn: { background: "#b91c1c", borderColor: "#dc2626" },
  error: { color: "#f87171", fontSize: 12, padding: "6px 16px", margin: 0 },
  scroll: { flex: 1, overflowY: "auto" },
  sectionHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 16px 4px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "#94a3b8",
  },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: "#818cf8",
    fontWeight: 700,
    fontSize: 12,
    cursor: "pointer",
  },
  list: { listStyle: "none", margin: 0, padding: "4px 8px" },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 8px",
    borderRadius: 10,
  },
  name: { display: "flex", alignItems: "center", gap: 6, fontSize: 14, minWidth: 0, flex: 1 },
  nameText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    background: "#334155",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  tag: {
    fontSize: 10,
    fontWeight: 700,
    background: "#4f46e5",
    color: "#fff",
    padding: "1px 6px",
    borderRadius: 6,
    flexShrink: 0,
  },
  tagCo: { background: "#0e7490" },
  actions: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  state: { fontSize: 13 },
  mini: {
    background: "#1e293b",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "4px 8px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  miniPrimary: { background: "#4f46e5", borderColor: "#6366f1", color: "#fff" },
  miniDanger: { background: "#7f1d1d", borderColor: "#b91c1c", color: "#fff" },
  menu: {
    position: "absolute",
    right: 0,
    top: "110%",
    minWidth: 180,
    background: "#111827",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: 4,
    zIndex: 60,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    display: "flex",
    flexDirection: "column",
  },
  menuItem: {
    background: "transparent",
    border: "none",
    color: "#e2e8f0",
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  },
  perms: { borderTop: "1px solid #1e293b", marginTop: 8, paddingBottom: 12 },
  toggle: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "7px 16px",
    fontSize: 14,
    cursor: "pointer",
  },
  footer: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #1e293b" },
  footerBtn: {
    flex: 1,
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 10,
    padding: "9px 10px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};
