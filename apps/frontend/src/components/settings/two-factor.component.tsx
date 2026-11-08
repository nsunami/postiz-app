'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

interface TwoFactorStatus {
  enabled: boolean;
}

interface TwoFactorSetup {
  secret: string;
  uri: string;
  qr: string;
}

export const useTwoFactor = () => {
  const fetch = useFetch();

  const load = useCallback(async () => {
    return (await fetch('/user/2fa')).json();
  }, []);

  return useSWR<TwoFactorStatus>('two-factor', load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });
};

const TwoFactorComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const user = useUser();
  const { data, isLoading, mutate } = useTwoFactor();

  const [mode, setMode] = useState<'idle' | 'setup' | 'disable' | 'recovery'>(
    'idle'
  );
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [useCodeInstead, setUseCodeInstead] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const post = useCallback(
    async (url: string, body: object = {}) => {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (response.status >= 400) {
        throw new Error(await response.text());
      }

      return response.json();
    },
    [fetch]
  );

  const reset = useCallback(() => {
    setMode('idle');
    setSetup(null);
    setCode('');
    setPassword('');
    setUseCodeInstead(false);
    setError('');
  }, []);

  const startSetup = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSetup(await post('/user/2fa/setup'));
      setMode('setup');
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, [post]);

  const enable = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await post('/user/2fa/enable', { code: code.trim() });
      setRecoveryCodes(result.recoveryCodes);
      setCode('');
      setSetup(null);
      setMode('idle');
      mutate({ enabled: true });
      toaster.show(
        t('two_factor_enabled', 'Two-factor authentication enabled'),
        'success'
      );
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, [code, post, mutate, toaster, t]);

  const disable = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await post(
        '/user/2fa/disable',
        useCodeInstead ? { code: code.trim() } : { password }
      );
      setRecoveryCodes(null);
      mutate({ enabled: false });
      reset();
      toaster.show(
        t('two_factor_disabled', 'Two-factor authentication disabled'),
        'success'
      );
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, [post, useCodeInstead, code, password, mutate, reset, toaster, t]);

  const regenerateRecoveryCodes = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await post('/user/2fa/recovery-codes', {
        code: code.trim(),
      });
      setRecoveryCodes(result.recoveryCodes);
      reset();
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, [post, code, reset]);

  // The second factor is only asked for LOCAL (email + password) logins, so
  // there is nothing to enroll for delegated providers.
  if (user?.providerName !== 'LOCAL') {
    return null;
  }

  const enabled = !!data?.enabled;

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[24px]">
      <div className="mt-[4px]">
        {t('two_factor_authentication', 'Two-factor authentication')}
      </div>

      {isLoading ? (
        <div className="animate-pulse text-[14px]">
          {t('loading', 'Loading...')}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-[24px]">
          <div className="flex flex-col flex-1">
            <div className="text-[14px]">
              {enabled
                ? t('two_factor_enabled_label', 'Enabled')
                : t('two_factor_disabled_label', 'Disabled')}
            </div>
            <div className="text-[12px] text-customColor18">
              {t(
                'two_factor_description',
                'Ask for a code from your authenticator app in addition to your password.'
              )}
            </div>
          </div>
          {mode === 'idle' &&
            (enabled ? (
              <Button secondary={true} onClick={() => setMode('disable')}>
                {t('disable', 'Disable')}
              </Button>
            ) : (
              <Button onClick={startSetup} loading={loading}>
                {t('enable', 'Enable')}
              </Button>
            ))}
        </div>
      )}

      {mode === 'setup' && !!setup && (
        <div className="flex flex-col gap-[16px]">
          <div className="text-[14px]">
            {t(
              'two_factor_scan_qr',
              'Scan this QR code with your authenticator app'
            )}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={setup.qr}
            width={200}
            height={200}
            alt={t('two_factor_qr_alt', 'Two-factor QR code')}
            className="bg-white p-[8px] rounded-[8px]"
          />
          <div className="text-[12px] text-customColor18 break-all">
            {t('two_factor_manual_secret', 'Or enter this secret manually')}:{' '}
            <span className="select-all">{setup.secret}</span>
          </div>
          <div className="flex flex-col gap-[6px]">
            <Input
              label={t('two_factor_code', 'Authentication code')}
              name="two-factor-confirm-code"
              disableForm={true}
              removeError={true}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
          </div>
          <div className="flex gap-[12px]">
            <Button onClick={enable} loading={loading}>
              {t('two_factor_verify_and_enable', 'Verify and enable')}
            </Button>
            <Button secondary={true} onClick={reset}>
              {t('cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'disable' && (
        <div className="flex flex-col gap-[16px]">
          <div className="text-[14px]">
            {t(
              'two_factor_confirm_disable',
              'Confirm turning off two-factor authentication'
            )}
          </div>
          <div className="flex flex-col gap-[6px]">
            {useCodeInstead ? (
              <Input
                label={t('two_factor_code', 'Authentication code')}
                name="two-factor-disable-code"
                disableForm={true}
                removeError={true}
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            ) : (
              <Input
                label={t('password', 'Password')}
                name="two-factor-disable-password"
                disableForm={true}
                removeError={true}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
            {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
          </div>
          <button
            type="button"
            className="text-[14px] underline cursor-pointer self-start"
            onClick={() => {
              setUseCodeInstead(!useCodeInstead);
              setError('');
            }}
          >
            {useCodeInstead
              ? t('two_factor_use_password', 'Use my password instead')
              : t('two_factor_use_code', 'Use an authenticator code instead')}
          </button>
          <div className="flex gap-[12px]">
            <Button onClick={disable} loading={loading}>
              {t('disable', 'Disable')}
            </Button>
            <Button secondary={true} onClick={reset}>
              {t('cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'recovery' && (
        <div className="flex flex-col gap-[16px]">
          <div className="text-[14px]">
            {t(
              'two_factor_regenerate_description',
              'Enter an authenticator code to generate a new set of recovery codes.'
            )}
          </div>
          <div className="flex flex-col gap-[6px]">
            <Input
              label={t('two_factor_code', 'Authentication code')}
              name="two-factor-recovery-code"
              disableForm={true}
              removeError={true}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            {!!error && <div className="text-red-400 text-[12px]">{error}</div>}
          </div>
          <div className="flex gap-[12px]">
            <Button onClick={regenerateRecoveryCodes} loading={loading}>
              {t('two_factor_regenerate', 'Regenerate recovery codes')}
            </Button>
            <Button secondary={true} onClick={reset}>
              {t('cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {enabled && mode === 'idle' && (
        <button
          type="button"
          className="text-[14px] underline cursor-pointer self-start"
          onClick={() => {
            setCode('');
            setError('');
            setMode('recovery');
          }}
        >
          {t('two_factor_regenerate', 'Regenerate recovery codes')}
        </button>
      )}

      {!!recoveryCodes && (
        <div className="flex flex-col gap-[12px] border-fifth border rounded-[8px] p-[16px]">
          <div className="text-[14px]">
            {t(
              'two_factor_recovery_codes_once',
              'Save these recovery codes somewhere safe. Each code can be used once and they will not be shown again.'
            )}
          </div>
          <div className="grid grid-cols-2 gap-[8px] font-mono text-[14px]">
            {recoveryCodes.map((recoveryCode) => (
              <div key={recoveryCode}>{recoveryCode}</div>
            ))}
          </div>
          <Button
            secondary={true}
            onClick={() => setRecoveryCodes(null)}
            className="self-start"
          >
            {t('two_factor_saved_codes', 'I saved my codes')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default TwoFactorComponent;
