import { KeyRound, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { errorText, request } from './api';
import type { AccessStatus } from './api';
import { useLocale } from './locale';

export function GroupAccess({ dialog, onLogin }: {
  dialog: RefObject<HTMLDialogElement | null>;
  onLogin: (status: AccessStatus) => void;
}) {
  const { t, text } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const passcode = String(new FormData(form).get('passcode') ?? '').trim();
    form.reset();
    setPending(true);
    setError('');
    try {
      const status = await request<AccessStatus>('/api/access', { passcode });
      onLogin(status);
      dialog.current?.close();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog className="sim-dialog" ref={dialog} aria-labelledby="access-title" onClose={() => setError('')}>
      <form className="sim-wrap" onSubmit={(event) => void login(event)}>
        <div className="sim-heading">
          <span className="section-icon"><KeyRound size={21} /></span>
          <h2 id="access-title">{t('组内登录')}</h2>
          <button className="icon-button" type="button" aria-label={t('关闭登录')} onClick={() => dialog.current?.close()}><X size={20} /></button>
        </div>
        <p className="access-note">{t('登录后可以操作设备、清运工单和使用在线模型。')}</p>
        <label className="access-field">
          {t('组内口令')}
          <input name="passcode" type="password" autoComplete="current-password" required maxLength={256} disabled={pending} />
        </label>
        {error && <p className="callout error" role="alert">{text(error)}</p>}
        <button className="primary recognize" type="submit" disabled={pending}>{t(pending ? '正在登录…' : '登录')}</button>
      </form>
    </dialog>
  );
}
