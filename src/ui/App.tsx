import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { loadRepo, loadSession, saveRepo, saveSession, type SelectedRepo, type Session } from '../lib/auth';
import { JournalDb } from '../lib/db';
import { todayKey } from '../lib/dates';
import { SignIn } from './SignIn';
import { RepoPicker } from './RepoPicker';
import { JournalScreen } from './Journal';
import { HistoryScreen } from './History';
import { SettingsScreen } from './Settings';
import { YearsScreen } from './Years';
import { useWorkspace } from './workspace';

type Screen = 'journal' | 'history' | 'years' | 'settings';

/** Back after this long in the background and we reopen on today. */
const RESET_TO_TODAY_AFTER_MS = 30 * 60_000;

export function App() {
  const [boot, setBoot] = useState<{ session: Session | null; repo: SelectedRepo | null } | null>(null);

  useEffect(() => {
    void Promise.all([loadSession(), loadRepo()]).then(([session, repo]) => setBoot({ session, repo }));
  }, []);

  if (!boot) return <div className="app" />;

  const setSession = async (session: Session | null) => {
    await saveSession(session);
    if (!session) await saveRepo(null);
    setBoot({ session, repo: session ? boot.repo : null });
  };
  const setRepo = async (repo: SelectedRepo | null) => {
    await saveRepo(repo);
    setBoot({ ...boot, repo });
  };

  if (!boot.session) return <SignIn onSignedIn={setSession} />;
  if (!boot.repo) return <RepoPicker session={boot.session} onPick={setRepo} onSignOut={() => setSession(null)} />;
  return (
    <Main
      key={boot.repo.fullName}
      session={boot.session}
      repo={boot.repo}
      onSwitchRepo={() => setRepo(null)}
      onSignOut={async (keepLocal) => {
        if (!keepLocal) await JournalDb.destroy(boot.repo!.fullName);
        await setSession(null);
      }}
    />
  );
}

function Main(props: { session: Session; repo: SelectedRepo; onSwitchRepo: () => void; onSignOut: (keepLocal: boolean) => void }) {
  const ws = useWorkspace(props.session, props.repo);
  const [screen, setScreen] = useState<Screen>('journal');
  // Always open on today.
  const [date, setDate] = useState(todayKey);
  const hiddenAt = useRef<{ at: number; day: string } | null>(null);

  // Coming back to the app: jump to today if the day changed or we were away a while.
  useEffect(() => {
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        hiddenAt.current = { at: Date.now(), day: todayKey() };
        return;
      }
      const h = hiddenAt.current;
      if (h && (h.day !== todayKey() || Date.now() - h.at > RESET_TO_TODAY_AFTER_MS)) {
        setDate(todayKey());
        setScreen('journal');
      }
    });
    return () => void sub.then((s) => s.remove());
  }, []);

  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const sub = CapApp.addListener('backButton', () => {
      if (screenRef.current !== 'journal') setScreen('journal');
      else void CapApp.minimizeApp();
    });
    return () => void sub.then((s) => s.remove());
  }, []);

  const openDate = useCallback((d: string) => {
    setDate(d);
    setScreen('journal');
  }, []);

  if (!ws) return <div className="app" />;

  switch (screen) {
    case 'history':
      return <HistoryScreen ws={ws} onOpen={openDate} onBack={() => setScreen('journal')} />;
    case 'years':
      return <YearsScreen ws={ws} onOpen={openDate} onBack={() => setScreen('journal')} />;
    case 'settings':
      return (
        <SettingsScreen
          ws={ws}
          session={props.session}
          onBack={() => setScreen('journal')}
          onSwitchRepo={props.onSwitchRepo}
          onSignOut={props.onSignOut}
        />
      );
    default:
      return (
        <JournalScreen
          ws={ws}
          date={date}
          onDate={setDate}
          onHistory={() => setScreen('history')}
          onYears={() => setScreen('years')}
          onSettings={() => setScreen('settings')}
        />
      );
  }
}
