// Scheduled meetings on the home screen: list the signed-in user's upcoming
// meetings (start, share invitation, delete) and schedule new ones. Talks to
// the Next.js server's /api/meetings endpoint, same as the web app.
//
// Date/time are picked with steppers rather than a native picker so this
// works without adding a native module (and a dev-client rebuild).

import { useEffect, useState } from 'react';
import { Modal, Pressable, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

import { API_BASE } from './config';
import { joinUrl } from './meeting';
import type { BeldexUser } from './auth';

type ScheduledMeeting = {
  id: string;
  room: string;
  title: string;
  startsAt: string;
  durationMin: number;
  waitingRoom: boolean;
};

const DURATIONS = [15, 30, 45, 60, 90];

// Default slot: the next half hour.
function nextSlot(): Date {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

const fmtDate = (d: Date) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function ScheduledMeetings({
  user,
  onStart,
}: {
  user: BeldexUser;
  onStart: (room: string) => void;
}) {
  const [meetings, setMeetings] = useState<ScheduledMeeting[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  // Bumped to re-fetch after a change.
  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/meetings?owner=${encodeURIComponent(user.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (active && body) setMeetings(body.meetings ?? []);
      })
      .catch(() => {
        /* server unreachable — keep the current list */
      });
    return () => {
      active = false;
    };
  }, [user.id, version]);

  const remove = async (id: string) => {
    setError('');
    try {
      await fetch(
        `${API_BASE}/api/meetings?id=${encodeURIComponent(id)}&owner=${encodeURIComponent(user.id)}`,
        { method: 'DELETE' },
      );
    } catch {
      setError('Could not delete the meeting.');
    }
    load();
  };

  const share = (m: ScheduledMeeting) => {
    const when = `${fmtDate(new Date(m.startsAt))}, ${fmtTime(new Date(m.startsAt))}`;
    Share.share({
      message:
        `${user.name} is inviting you to a Beldex Meet meeting.\n\n` +
        `Topic: ${m.title}\nTime: ${when}\nJoin: ${joinUrl(m.room)}\nMeeting code: ${m.room}`,
    }).catch(() => {});
  };

  return (
    <View style={s.card}>
      <View style={s.headRow}>
        <Text style={s.head}>Scheduled meetings</Text>
        <Pressable style={({ pressed }) => [s.smallBtn, pressed && s.pressed]} onPress={() => setOpen(true)}>
          <MaterialIcons name="event" size={16} color="#4f46e5" />
          <Text style={s.smallBtnText}>Schedule</Text>
        </Pressable>
      </View>
      {meetings.length === 0 && <Text style={s.empty}>No upcoming meetings.</Text>}
      {meetings.map((m) => (
        <View key={m.id} style={s.item}>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle} numberOfLines={1}>
              {m.title}
            </Text>
            <Text style={s.itemMeta}>
              {fmtDate(new Date(m.startsAt))} · {fmtTime(new Date(m.startsAt))} · {m.durationMin} min
            </Text>
            <Text style={s.itemMeta}>{m.room}</Text>
          </View>
          <View style={s.itemActions}>
            <Pressable onPress={() => onStart(m.room)} style={({ pressed }) => [s.startBtn, pressed && s.pressed]}>
              <Text style={s.startText}>Start</Text>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 14 }}>
              <Pressable onPress={() => share(m)} hitSlop={8} accessibilityLabel="Share invitation">
                <MaterialIcons name="share" size={20} color="#64748b" />
              </Pressable>
              <Pressable onPress={() => remove(m.id)} hitSlop={8} accessibilityLabel="Delete meeting">
                <MaterialIcons name="delete-outline" size={20} color="#dc2626" />
              </Pressable>
            </View>
          </View>
        </View>
      ))}
      {!!error && <Text style={s.error}>{error}</Text>}
      {/* Mounted only while open, so the form starts fresh each time. */}
      {open && (
        <ScheduleModal
          visible
          user={user}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            load();
          }}
        />
      )}
    </View>
  );
}

function ScheduleModal({
  visible,
  user,
  onClose,
  onSaved,
}: {
  visible: boolean;
  user: BeldexUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(nextSlot);
  const [duration, setDuration] = useState(30);
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const shift = (minutes: number) => {
    const next = new Date(start.getTime() + minutes * 60_000);
    if (next.getTime() > Date.now() - 60_000) setStart(next);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          startsAt: start.toISOString(),
          durationMin: duration,
          waitingRoom,
          ownerId: user.id,
          ownerName: user.name,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not schedule the meeting.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.headRow}>
            <Text style={s.head}>Schedule meeting</Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
              <MaterialIcons name="close" size={24} color="#64748b" />
            </Pressable>
          </View>

          <TextInput
            style={s.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Topic (e.g. Weekly sync)"
            placeholderTextColor="#9ca3af"
          />

          <Text style={s.label}>Date</Text>
          <Stepper value={fmtDate(start)} onMinus={() => shift(-24 * 60)} onPlus={() => shift(24 * 60)} />
          <Text style={s.label}>Time</Text>
          <Stepper value={fmtTime(start)} onMinus={() => shift(-15)} onPlus={() => shift(15)} />

          <Text style={s.label}>Duration</Text>
          <View style={s.chips}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d}
                onPress={() => setDuration(d)}
                style={[s.chip, duration === d && s.chipOn]}
              >
                <Text style={[s.chipText, duration === d && s.chipTextOn]}>{d} min</Text>
              </Pressable>
            ))}
          </View>

          <View style={s.switchRow}>
            <Text style={s.switchLabel}>Enable waiting room</Text>
            <Switch value={waitingRoom} onValueChange={setWaitingRoom} />
          </View>

          {!!error && <Text style={s.error}>{error}</Text>}
          <Pressable
            style={({ pressed }) => [s.saveBtn, (pressed || saving) && s.pressed]}
            disabled={saving}
            onPress={save}
          >
            <Text style={s.saveText}>{saving ? 'Saving…' : 'Save meeting'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Stepper({ value, onMinus, onPlus }: { value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={s.stepper}>
      <Pressable onPress={onMinus} hitSlop={8} style={s.stepBtn} accessibilityLabel="Earlier">
        <MaterialIcons name="chevron-left" size={26} color="#4f46e5" />
      </Pressable>
      <Text style={s.stepValue}>{value}</Text>
      <Pressable onPress={onPlus} hitSlop={8} style={s.stepBtn} accessibilityLabel="Later">
        <MaterialIcons name="chevron-right" size={26} color="#4f46e5" />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginTop: 16,
    gap: 10,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  head: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  smallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  smallBtnText: { color: '#4f46e5', fontWeight: '600', fontSize: 13 },
  pressed: { opacity: 0.7 },
  empty: { color: '#94a3b8', fontSize: 13 },
  item: {
    flexDirection: 'row',
    gap: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 14,
    padding: 12,
  },
  itemTitle: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  itemMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  itemActions: { alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 },
  startBtn: { backgroundColor: '#4f46e5', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 7 },
  startText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  error: { color: '#dc2626', fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    gap: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0f172a',
  },
  label: { fontSize: 13, color: '#475569', fontWeight: '600', marginTop: 4 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  stepBtn: { padding: 4 },
  stepValue: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipOn: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  chipText: { color: '#334155', fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  switchLabel: { fontSize: 15, color: '#0f172a' },
  saveBtn: { backgroundColor: '#4f46e5', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
