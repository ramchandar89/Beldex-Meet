"use client";

// In-call audio & video settings, opened from the control bar's Settings
// button (VideoConference's SettingsComponent slot): microphone, speaker and
// camera selection, a mic level meter, a speaker test tone, noise suppression /
// echo cancellation, and self-view options.

import { useEffect, useState } from "react";
import {
  useLocalParticipant,
  useMaybeLayoutContext,
  useMediaDeviceSelect,
  useRoomContext,
  useTrackVolume,
} from "@livekit/components-react";
import { LocalAudioTrack, Track } from "livekit-client";
import { useViewPrefs } from "./meeting";

const AUDIO_KEY = "beldex-meet-audio-processing";

// Speaker selection relies on HTMLMediaElement.setSinkId (Chrome, Edge, Firefox 116+).
const canPickSpeaker = () =>
  typeof window !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export default function SettingsPanel() {
  const layout = useMaybeLayoutContext();
  const room = useRoomContext();
  const { localParticipant, microphoneTrack } = useLocalParticipant();
  const { prefs, setPrefs } = useViewPrefs();

  const mics = useMediaDeviceSelect({ kind: "audioinput", room });
  const cams = useMediaDeviceSelect({ kind: "videoinput", room });
  const speakers = useMediaDeviceSelect({ kind: "audiooutput", room });

  const micTrack = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : undefined;
  const level = useTrackVolume(micTrack);

  const [processing, setProcessing] = useState({ noiseSuppression: true, echoCancellation: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUDIO_KEY);
      if (raw) setProcessing((p) => ({ ...p, ...JSON.parse(raw) }));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const close = () => layout?.widget.dispatch?.({ msg: "toggle_settings" });

  const pick = async (sel: ReturnType<typeof useMediaDeviceSelect>, id: string) => {
    setError(null);
    try {
      await sel.setActiveMediaDevice(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch device");
    }
  };

  // Re-acquire the mic with new processing constraints; also becomes the
  // default for any later re-publish.
  const updateProcessing = async (patch: Partial<typeof processing>) => {
    const next = { ...processing, ...patch };
    setProcessing(next);
    try {
      window.localStorage.setItem(AUDIO_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, ...next };
    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    if (pub?.track instanceof LocalAudioTrack) {
      try {
        await pub.track.restartTrack({ ...next, deviceId: mics.activeDeviceId || undefined });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update microphone");
      }
    }
  };

  // Play a short tone through the selected speaker.
  const testSpeaker = async () => {
    setError(null);
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      osc.frequency.value = 660;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      const sinkId = speakers.activeDeviceId;
      if (sinkId && canPickSpeaker()) {
        await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId);
      }
      osc.start();
      await el.play();
      setTimeout(() => {
        osc.stop();
        el.pause();
        ctx.close();
      }, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not play test sound");
    }
  };

  return (
    <div style={s.root} data-testid="settings-panel">
      <div style={s.head}>
        <strong style={{ fontSize: 18 }}>Settings</strong>
        <button style={s.close} onClick={close} aria-label="Close settings">
          ✕
        </button>
      </div>

      <h3 style={s.h3}>Audio</h3>
      <DeviceSelect label="Microphone" sel={mics} onPick={(id) => pick(mics, id)} />
      <div style={s.meterRow}>
        <span style={s.small}>Input level</span>
        <div style={s.meter}>
          <div style={{ ...s.meterFill, width: `${Math.min(100, Math.round(level * 250))}%` }} />
        </div>
      </div>
      {canPickSpeaker() ? (
        <DeviceSelect label="Speaker" sel={speakers} onPick={(id) => pick(speakers, id)} />
      ) : (
        <p style={s.small}>This browser always uses the system speaker.</p>
      )}
      <button style={s.btn} onClick={testSpeaker}>
        Test speaker
      </button>
      <Check
        label="Suppress background noise"
        checked={processing.noiseSuppression}
        onChange={(v) => updateProcessing({ noiseSuppression: v })}
      />
      <Check
        label="Echo cancellation"
        checked={processing.echoCancellation}
        onChange={(v) => updateProcessing({ echoCancellation: v })}
      />

      <h3 style={s.h3}>Video</h3>
      <DeviceSelect label="Camera" sel={cams} onPick={(id) => pick(cams, id)} />
      <Check
        label="Show my video (self view)"
        checked={prefs.showSelfView}
        onChange={(v) => setPrefs({ showSelfView: v })}
      />
      <Check
        label="Mirror my video"
        checked={prefs.mirrorSelf}
        onChange={(v) => setPrefs({ mirrorSelf: v })}
      />

      {error && <p style={s.error}>{error}</p>}
    </div>
  );
}

function DeviceSelect({
  label,
  sel,
  onPick,
}: {
  label: string;
  sel: ReturnType<typeof useMediaDeviceSelect>;
  onPick: (id: string) => void;
}) {
  return (
    <label style={s.field}>
      <span style={s.small}>{label}</span>
      <select
        style={s.select}
        value={sel.activeDeviceId}
        onChange={(e) => onPick(e.target.value)}
        aria-label={label}
      >
        {sel.devices.length === 0 && <option value="">No devices found</option>}
        {sel.devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={s.check}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16, accentColor: "#4f46e5" }}
      />
      {label}
    </label>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 10, minWidth: "min(420px, 80vw)" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  close: { background: "transparent", border: "none", color: "inherit", fontSize: 18, cursor: "pointer" },
  h3: { margin: "8px 0 0", fontSize: 13, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.7 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  small: { fontSize: 12, opacity: 0.75, margin: 0 },
  select: {
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
    width: "100%",
  },
  meterRow: { display: "flex", alignItems: "center", gap: 10 },
  meter: { flex: 1, height: 6, background: "#1e293b", borderRadius: 3, overflow: "hidden" },
  meterFill: { height: "100%", background: "#22c55e", transition: "width 80ms linear" },
  btn: {
    alignSelf: "flex-start",
    background: "#1e293b",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" },
  error: { color: "#f87171", fontSize: 12, margin: 0 },
};
