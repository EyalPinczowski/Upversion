import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { isApiError } from '../api/errors';
import { useCalendarStatus } from '../api/calendar-hooks';
import { useDeleteAccount, useExportData, useMe, useUpdateDisplayName } from '../api/hooks';
import { useAuth } from '../auth/AuthProvider';
import type { AppEnv } from '../env';
import { Button, ErrorText, linkClass, TextField } from '../components/ui';
import { DELETE_PHRASE, EXPORT_FILENAME } from '../lib/account';
import { downloadJson } from '../lib/download';
import { LEGAL_PAGES } from '../lib/legal';
import { AiUsageMeter } from './settings/AiUsageMeter';
import { HelpSection } from './settings/HelpSection';
import { ChangeCvSettings } from './settings/ChangeCvSettings';
import { SetupSettings } from './settings/SetupSettings';
import { CalendarSettings } from './settings/CalendarSettings';
import { useTheme, type ThemePreference } from '../lib/theme';

const MAX_NAME_LENGTH = 80;

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Follow my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="space-y-3 rounded-md border border-border bg-surface p-4"
    >
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** Words for a failed request: whether the server could not be reached, or refused. */
const problem = (error: unknown, whenRefused: string) =>
  isApiError(error) && error.kind !== 'http'
    ? 'Can’t reach the server. Check your connection and try again.'
    : whenRefused;

function ProfileSection() {
  const me = useMe();
  const update = useUpdateDisplayName();
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);

  const stored = me.data?.displayName ?? '';
  const value = draft ?? stored;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const name = value.trim();
    if (name.length > MAX_NAME_LENGTH) {
      setInvalid(`Use at most ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    setInvalid(null);
    update.mutate(name === '' ? null : name, {
      onSuccess: () => {
        setDraft(null);
        setSaved(true);
      },
    });
  }

  const error =
    invalid ??
    (update.error ? problem(update.error, 'We couldn’t save that name. Try another.') : null);

  return (
    <Section id="profile-heading" title="Profile">
      <p>
        Signed in as <strong>{me.data?.email}</strong>
      </p>
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <TextField
          label="Display name"
          hint="Optional. Shown only to you."
          autoComplete="nickname"
          value={value}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          error={error}
        />
        <Button type="submit" variant="primary" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save name'}
        </Button>
        <p role="status" className="font-bold text-ok">
          {saved ? 'Saved.' : ''}
        </p>
      </form>
    </Section>
  );
}

function AppearanceSection() {
  const { preference, choose } = useTheme();
  return (
    <Section id="appearance-heading" title="Appearance">
      <fieldset className="space-y-1">
        <legend className="font-bold">Theme</legend>
        {THEMES.map(({ value, label }) => (
          <label key={value} className="flex min-h-11 items-center gap-3">
            <input
              type="radio"
              name="theme"
              value={value}
              checked={preference === value}
              onChange={() => choose(value)}
              className="size-5 accent-accent"
            />
            {label}
          </label>
        ))}
      </fieldset>
    </Section>
  );
}

function DataSection() {
  const exportData = useExportData();
  const [done, setDone] = useState(false);

  function onExport() {
    setDone(false);
    exportData.mutate(undefined, {
      onSuccess: (data) => {
        downloadJson(EXPORT_FILENAME, data);
        setDone(true);
      },
    });
  }

  return (
    <Section id="data-heading" title="Your data">
      <p className="text-muted">Download everything your account holds as a JSON file.</p>
      <Button onClick={onExport} disabled={exportData.isPending}>
        {exportData.isPending ? 'Preparing…' : 'Export my data'}
      </Button>
      <div role="status">
        {done ? <p className="font-bold text-ok">Your export was downloaded.</p> : null}
      </div>
      {exportData.error ? (
        <ErrorText>
          {problem(exportData.error, 'We couldn’t prepare your export. Try again.')}
        </ErrorText>
      ) : null}
    </Section>
  );
}

function SignOutSection() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState<'local' | 'global' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scope: 'local' | 'global') {
    setBusy(scope);
    setError(null);
    try {
      await signOut(scope);
    } catch {
      setError(
        scope === 'global'
          ? 'We couldn’t sign you out everywhere. Check your connection and try again.'
          : 'We couldn’t sign you out. Try again.',
      );
      setBusy(null);
    }
  }

  return (
    <Section id="signout-heading" title="Sign out">
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void run('local')} disabled={busy !== null}>
          Sign out
        </Button>
        <Button onClick={() => void run('global')} disabled={busy !== null}>
          Sign out of all devices
        </Button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Section>
  );
}

function DeleteSection({ appEnv }: { appEnv: AppEnv }) {
  const { signOut } = useAuth();
  const remove = useDeleteAccount();
  const [typed, setTyped] = useState('');
  const [signOutFailed, setSignOutFailed] = useState(false);

  // Case matters; surrounding spaces (a phone keyboard may add one) do not.
  const confirmed = typed.trim() === DELETE_PHRASE;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    // Always send the fixed phrase, never whatever was typed.
    remove.mutate(DELETE_PHRASE, {
      onSuccess: async () => {
        try {
          await signOut('local', 'accountDeleted');
        } catch {
          // The account is gone; if clearing this browser's session failed, say so.
          setSignOutFailed(true);
        }
      },
    });
  }

  const error = remove.error
    ? problem(remove.error, 'We couldn’t delete the account. Nothing was changed. Try again.')
    : null;

  return (
    <Section id="delete-heading" title="Delete my account">
      {appEnv === 'rnd' ? (
        <p>
          This permanently deletes your plans, progress and settings in this test environment. It
          can’t be undone. R&D test account: your sign-in record stays because it is shared with the
          live app. Download your data first if you want a copy.
        </p>
      ) : (
        <p>
          This permanently deletes your account and everything in it: your plans, progress, settings
          and sign-in record (your email). It can’t be undone. Download your data first if you want
          a copy.
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <TextField
          label={`Type “${DELETE_PHRASE}” to confirm`}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          error={error}
        />
        <Button type="submit" variant="danger" disabled={!confirmed || remove.isPending}>
          {remove.isPending ? 'Deleting…' : 'Delete my account'}
        </Button>
        {signOutFailed ? (
          <ErrorText>
            Your account was deleted, but this browser is still signed in. Reload the page.
          </ErrorText>
        ) : null}
      </form>
    </Section>
  );
}

/** Anchors the per-plan settings had while they lived on this page. */
const MOVED_TO_PLAN_SETTINGS = new Set([
  '#time-heading',
  '#practice-heading',
  '#start-date-heading',
]);

/** Two groups: the app itself, and what it connects to. Per-plan settings live on the Plan page. */
export function SettingsPage({ appEnv = 'operational' }: { appEnv?: AppEnv }) {
  const { hash } = useLocation();
  const navigate = useNavigate();
  // The calendar feature can be off on the server; then there is nothing to connect.
  const calendar = useCalendarStatus();
  const showConnections =
    calendar.isError || (calendar.data !== null && calendar.data !== undefined);
  // Old links such as `/settings#time-heading` land on the Plan settings tab.
  useEffect(() => {
    if (MOVED_TO_PLAN_SETTINGS.has(hash))
      void navigate(`/plan?tab=settings${hash}`, { replace: true });
  }, [hash, navigate]);
  return (
    <div className="space-y-6">
      <h1>Settings</h1>
      <section aria-labelledby="app-settings-heading" className="space-y-6">
        <h2 id="app-settings-heading">App</h2>
        <ProfileSection />
        <SetupSettings />
        <ChangeCvSettings />
        <AppearanceSection />
        <AiUsageMeter />
        <HelpSection />
        <DataSection />
        <SignOutSection />
        <DeleteSection appEnv={appEnv} />
        <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.values(LEGAL_PAGES).map((page) => (
            <Link key={page.slug} className={linkClass} to={page.path}>
              {page.title}
            </Link>
          ))}
        </nav>
      </section>
      {showConnections ? (
        <section aria-labelledby="connections-heading" className="space-y-6">
          <h2 id="connections-heading">Connections</h2>
          <CalendarSettings />
        </section>
      ) : null}
    </div>
  );
}
