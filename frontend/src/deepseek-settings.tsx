import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { errorText, request } from './api';
import { useLocale } from './locale';

type Config = {
  configured: boolean;
  model: string;
  source: 'saved' | 'environment' | 'none';
};
export function DeepSeekSettings({
  disabled,
  onSaved,
}: {
  disabled: boolean;
  onSaved: () => void;
}) {
  const { t, text } = useLocale();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('deepseek-flash');
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function load() {
    setPending('load');
    setError('');
    setMessage('');
    try {
      const value = await request<Config>('/api/model-config');
      setConfig(value);
      setModel(value.model);
      setKey('');
    } catch (cause) {
      setError(errorText(cause));
      setConfig(null);
    } finally {
      setPending('');
    }
  }
  useEffect(() => {
    if (!open) return;
    void load();
    const reload = () => void load();
    window.addEventListener('campus-group-access-changed', reload);
    return () =>
      window.removeEventListener('campus-group-access-changed', reload);
  }, [open]);
  async function submit(action: 'save' | 'test') {
    if (pending || disabled) return;
    setPending(action);
    setError('');
    setMessage('');
    try {
      const payload = { api_key: key, model };
      if (action === 'test') {
        await request('/api/model-config/test', payload);
        setMessage('连接测试通过。若修改了配置，请点击保存后再生成建议。');
      } else {
        const value = await request<Config>('/api/model-config', payload);
        setConfig(value);
        setModel(value.model);
        setKey('');
        onSaved();
        setMessage(
          '已保存到服务器并立即生效，组员可跨设备使用。保存不代表连接测试通过。',
        );
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending('');
    }
  }
  const changed = () => {
    setMessage('');
    setError('');
  };
  return (
    <section className="deepseek-settings" aria-label={t('DeepSeek 配置')}>
      <div className="deepseek-settings-heading">
        <div>
          <h3>
            <KeyRound size={18} />
            {t('DeepSeek 配置')}
          </h3>
          <p>{t('组内共享，配置一次即可在手机和电脑上使用。')}</p>
        </div>
        <button
          className="outline"
          type="button"
          aria-expanded={open}
          aria-controls="deepseek-config-form"
          disabled={!!pending || disabled}
          onClick={() => {
            setOpen(!open);
            setKey('');
            setMessage('');
            setError('');
          }}
        >
          {t(open ? '收起配置' : '配置 API')}
        </button>
      </div>
      {open && (
        <form
          id="deepseek-config-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit('save');
          }}
        >
          <div className="deepseek-config-status">
            <span>
              {t(
                config
                  ? config.configured
                    ? '服务器已配置密钥'
                    : '服务器尚未配置密钥'
                  : '请先组内登录后读取配置',
              )}
            </span>
            <button
              type="button"
              className="outline"
              disabled={!!pending || disabled}
              onClick={() => void load()}
            >
              {t(pending === 'load' ? '正在加载…' : '重新读取配置')}
            </button>
          </div>
          <fieldset disabled={!!pending || disabled || !config}>
            <div className="deepseek-fields">
              <label>
                {t('DeepSeek API Key')}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  maxLength={512}
                  required={!config?.configured}
                  placeholder={t(
                    config?.configured
                      ? '留空则保留服务器已有密钥'
                      : '粘贴你的 DeepSeek API Key',
                  )}
                  onChange={(e) => {
                    setKey(e.target.value);
                    changed();
                  }}
                />
              </label>
              <label>
                {t('模型名称')}
                <input
                  value={model}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={100}
                  required
                  placeholder="deepseek-flash"
                  onChange={(e) => {
                    setModel(e.target.value);
                    changed();
                  }}
                />
              </label>
            </div>
            <p className="model-api-help">
              {t(
                '密钥仅保存在本站服务器，不回显给组员，也不会写入 GitHub。已登录组员将共用该账号额度，并可更新配置。',
              )}
            </p>
            {config?.source === 'environment' && (
              <p className="model-api-help">
                {t('当前使用 Railway 环境变量。保存后，本页面配置将优先使用。')}
              </p>
            )}
            <div className="deepseek-actions">
              <button
                className="outline"
                type="button"
                disabled={!model.trim() || (!config?.configured && !key.trim())}
                onClick={() => void submit('test')}
              >
                {t(pending === 'test' ? '正在测试…' : '测试连接')}
              </button>
              <button className="primary" type="submit">
                {t(pending === 'save' ? '正在保存…' : '保存共享配置')}
              </button>
            </div>
            <p className="model-api-help">
              {t(
                '测试连接会向 DeepSeek 发送一次简短请求，可能消耗少量额度；不会发送工单。生成建议时才发送汇总统计。',
              )}
            </p>
          </fieldset>
          {error && (
            <p className="callout error" role="alert">
              {text(error)}
            </p>
          )}
          {message && (
            <p className="deepseek-feedback" role="status">
              {text(message)}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
